import { type Exec, spawnExec } from "../runtime/exec.ts";
import { hcCall, isKind } from "../runtime/hc/exec.ts";
import { parseProbe } from "../runtime/hc/probe.ts";
import { close as hcClose, slugName } from "../runtime/hc/sessions.ts";
import type { Probe, SessionRef } from "../runtime/types.ts";
import { argvHasMarker } from "./marker.ts";
import { oneLine, type PaneAdapter, type PaneProbe } from "./panes.ts";

const OPS_GROUP = "dori-ops";

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((r): r is Row => typeof r === "object" && r !== null) : [];
const local = (address: string): boolean => address !== "" && !address.includes("/");

export type HcPanesOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exec?: Exec;
  readonly shell?: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
};

/**
 * hc's half of pane placement: one label group (`dori.group=dori-ops`), one terminal named after the unit. The terminal
 * record carries the foreground process for the pid, so a remote or local terminal answers the same way.
 */
export class HcPanes implements PaneAdapter {
  readonly kind = "hc" as const;
  private readonly exec: Exec;
  private readonly shell: string;

  constructor(private readonly options: HcPanesOptions) {
    this.exec = options.exec ?? spawnExec;
    this.shell = options.shell ?? process.env["SHELL"] ?? "sh";
  }

  async ready(): Promise<void> {
    await hcCall(this.exec, ["ls", "--label", `dori.group=${OPS_GROUP}`]);
  }

  async panes(name: string): Promise<readonly SessionRef[]> {
    const listed = rows((await hcCall(this.exec, ["ls", "--label", `dori.group=${OPS_GROUP}`]))["terminals"]).filter(
      (t) => str(t["state"]) === "live" && local(str(t["address"])),
    );
    const found: SessionRef[] = [];
    for (const terminal of listed) {
      const id = str(terminal["address"]);
      const detail = await hcCall(this.exec, ["get", id]);
      const unit = str(asRow(detail["labels"])?.["dori.unit"]);
      if (unit === name || str(detail["name"]) === slugName(name)) found.push({ runtime: "hc", id, group: OPS_GROUP });
    }
    return found;
  }

  async open(name: string): Promise<SessionRef> {
    const slug = slugName(name);
    let result: Record<string, unknown>;
    try {
      result = await hcCall(this.exec, this.runArgv(name, slug));
    } catch (e) {
      if (slug === undefined || !isKind(e, "name_taken")) throw e;
      result = await hcCall(this.exec, this.runArgv(name, undefined));
    }
    const id = str(result["address"]);
    if (id === "") throw new Error("hc did not return a terminal address");
    return { runtime: "hc", id, group: OPS_GROUP };
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    await hcCall(this.exec, ["send", ref.id, "--", command]);
  }

  /**
   * The unit's pid, matched by pid and command: the terminal's foreground argv must be exactly the unit's marker after
   * its interpreter. A record with no argv (or a one-word argv) carries no command line to match, so it is doubt, never
   * a match — a foreign bun in a unit pane must not suppress the unit.
   */
  async pid(ref: SessionRef, marker: readonly string[], program?: string): Promise<PaneProbe> {
    let probe: Probe;
    try {
      probe = parseProbe(await hcCall(this.exec, ["get", ref.id]));
    } catch (e) {
      if (isKind(e, "not_found", "finished")) return { kind: "stopped" };
      return { kind: "unknown", why: oneLine(e) };
    }
    if (probe.status === "gone" || probe.shellInFront) return { kind: "stopped" };
    const foreground = probe.foreground?.[0];
    const pid = foreground?.pid;
    if (pid === undefined) return { kind: "unknown", why: "foreground pid missing" };
    const argv = foreground?.argv ?? [];
    if (argvHasMarker(argv, marker, program)) return { kind: "running", pid };
    // hc reports a process in front but no command line this unit can match. The pid is only a hint for a pane the
    // supervisor itself typed into; otherwise this is doubt, never a match.
    return {
      kind: "unknown",
      why: `pane foreground is another command: ${foreground?.name || argv[0] || "no command line"}`,
      pid,
    };
  }

  async close(ref: SessionRef): Promise<void> {
    await hcClose(this.exec, ref.id, this.options.sleep, this.options.log);
  }

  private runArgv(name: string, slug: string | undefined): string[] {
    return [
      "run",
      "--bg",
      "--no-parent",
      "--no-notify",
      "--cwd",
      this.options.home,
      "--label",
      `dori.group=${OPS_GROUP}`,
      "--label",
      `dori.unit=${name}`,
      ...(slug === undefined ? [] : ["--name", slug]),
      "--",
      "env",
      ...Object.entries(this.options.env).map(([k, v]) => `${k}=${v}`),
      this.shell,
    ];
  }
}
