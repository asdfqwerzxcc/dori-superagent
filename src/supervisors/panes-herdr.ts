import type { Exec } from "../runtime/exec.ts";
import { ToolError } from "../runtime/exec.ts";
import { HerdrCli } from "../runtime/herdr/exec.ts";
import type { ForegroundProcess, SessionRef } from "../runtime/types.ts";
import { bunChildren, listProcessTree, type ProcNode } from "../process-tree.ts";
import { foregroundMatch } from "./marker.ts";
import type { PaneAdapter, PaneProbe } from "./panes.ts";

const OPS_LABEL = "dori-ops";

type Row = Record<string, unknown>;
const asRow = (value: unknown): Row | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : undefined;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter((r): r is Row => typeof r === "object" && r !== null) : [];
const titled = (pane: Row, name: string): boolean => str(pane["label"]) === name || str(pane["title"]) === name;

const toRef = (pane: Row): SessionRef => ({
  runtime: "herdr",
  id: str(pane["pane_id"]),
  ...(str(pane["workspace_id"]) === "" ? {} : { group: str(pane["workspace_id"]) }),
  ...(str(pane["tab_id"]) === "" ? {} : { container: str(pane["tab_id"]) }),
});

const toProcess = (value: unknown): ForegroundProcess => {
  const p = asRow(value);
  const argv = Array.isArray(p?.["argv"]) ? p["argv"].map(String) : [];
  const name = str(p?.["name"]) || (argv[0] ?? "");
  const pid = p?.["pid"];
  return { name, argv, ...(typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
};

/** What `pane process-info` says about one pane: its shell pid and the foreground command lines it can read. */
type PaneInfo = { readonly shell?: number; readonly foreground: readonly ForegroundProcess[] };

export type HerdrPanesOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string>>;
  readonly exec?: Exec;
  readonly session?: string;
  /** Test seam: the process tree the probe reads; production takes the kernel snapshot (or ps) without a console app. */
  readonly tree?: () => Promise<readonly ProcNode[] | undefined>;
};

/**
 * herdr's half of pane placement: one workspace labelled `dori-ops`, one tab and pane per unit. The workspace's first
 * shell becomes the first unit's pane; every later unit gets a tab created without focus. The probe matches the unit by
 * pid and command: herdr's reported foreground command line when it can read one, else the pane shell's direct bun
 * child in the OS process tree. No command-line scan is spawned.
 */
export class HerdrPanes implements PaneAdapter {
  readonly kind = "herdr" as const;
  private readonly cli: HerdrCli;
  private readonly tree: () => Promise<readonly ProcNode[] | undefined>;
  private workspace: string | undefined;
  private spare: Row | undefined;
  private readiness: Promise<void> | undefined;

  constructor(private readonly options: HerdrPanesOptions) {
    this.cli = new HerdrCli(options.exec, options.session);
    this.tree = options.tree ?? (() => listProcessTree());
  }

  /**
   * One workspace for one adapter, even when every unit starts at once: concurrent callers share the same create, so a
   * restart never leaves several `dori-ops` workspaces (and their shells) behind.
   */
  ready(): Promise<void> {
    this.readiness ??= this.ensureWorkspace().catch((e: unknown) => {
      this.readiness = undefined;
      throw e;
    });
    return this.readiness;
  }

  private async ensureWorkspace(): Promise<void> {
    if (this.workspace !== undefined) return;
    const listed = rows((await this.cli.call(["workspace", "list"]))["workspaces"]);
    const found = listed.find((w) => str(w["label"]) === OPS_LABEL);
    if (found !== undefined) {
      this.workspace = str(found["workspace_id"]);
      return;
    }
    const created = await this.cli.call([
      "workspace",
      "create",
      "--label",
      OPS_LABEL,
      "--cwd",
      this.options.home,
      ...this.envFlags(),
      "--no-focus",
    ]);
    const root = asRow(created["root_pane"]);
    const id = str(root?.["workspace_id"]);
    if (id === "") throw new Error("herdr did not return the ops workspace id");
    this.workspace = id;
    this.spare = root;
  }

  async panes(name: string): Promise<readonly SessionRef[]> {
    if (this.workspace === undefined) return [];
    const listed = rows((await this.cli.call(["pane", "list"]))["panes"]);
    return listed.filter((p) => str(p["workspace_id"]) === this.workspace && titled(p, name)).map(toRef);
  }

  async open(name: string): Promise<SessionRef> {
    if (this.workspace === undefined) throw new Error("the ops workspace is not resolved");
    let pane = this.spare;
    this.spare = undefined;
    if (pane === undefined) {
      const created = await this.cli.call([
        "tab",
        "create",
        "--label",
        name,
        "--cwd",
        this.options.home,
        "--workspace",
        this.workspace,
        ...this.envFlags(),
        "--no-focus",
      ]);
      pane = asRow(created["root_pane"]);
    }
    if (pane === undefined) throw new Error("herdr did not return a pane for the unit");
    const tab = str(pane["tab_id"]);
    // The tab label is cosmetic; the pane label below is the title the duplicate check matches.
    if (tab !== "") await this.cli.call(["tab", "rename", tab, name]).catch(() => undefined);
    await this.cli.call(["pane", "rename", str(pane["pane_id"]), name]);
    return toRef(pane);
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    await this.cli.call(["pane", "run", ref.id, command]);
  }

  /**
   * The unit's pid, matched by pid and command: a foreground command line naming the marker wins; otherwise the pane
   * shell's one bun child is the unit. A pane busy with another readable command is doubt, never `stopped`, so a
   * placement never types over it.
   */
  async pid(ref: SessionRef, marker: readonly string[], program?: string): Promise<PaneProbe> {
    const info = await this.paneInfo(ref.id);
    if (info === undefined) return { kind: "unknown", why: `pane ${ref.id} process-info is unreadable` };
    const match = foregroundMatch(info.foreground, marker, program);
    if (match !== undefined) {
      // A named foreground beside another bun child can be a copy while the real unit runs in the background.
      const nodes = await this.tree();
      if (nodes === undefined) return { kind: "unknown", why: "process tree unavailable" };
      if (info.shell === undefined) return { kind: "unknown", why: `pane ${ref.id} process-info has no shell pid` };
      const children = bunChildren(nodes, info.shell);
      const others = children.filter((pid) => pid !== match);
      if (others.length > 0 || (children.length === 1 && children[0] !== undefined && children[0] !== match))
        return { kind: "unknown", why: `pane ${ref.id} foreground is not its only bun child` };
      return { kind: "running", pid: match };
    }
    if (info.shell === undefined) return { kind: "unknown", why: `pane ${ref.id} process-info has no shell pid` };
    const nodes = await this.tree();
    if (nodes === undefined) return { kind: "unknown", why: "process tree unavailable" };
    const children = bunChildren(nodes, info.shell);
    const [only] = children;
    const inFront = info.foreground.filter((p) => p.pid !== info.shell);
    const unreadable = inFront.length > 0 && inFront.every((p) => p.argv.length === 0 && p.pid !== undefined);
    // The shell's sole bun child with no readable command line in front is the unit: a path form herdr reports
    // differently, or a command line it cannot read, must not leave the unit unplaced forever.
    if (
      children.length === 1 &&
      only !== undefined &&
      (inFront.length === 0 || (unreadable && inFront.some((p) => p.pid === only)))
    )
      return { kind: "running", pid: only };
    if (children.length > 1) return { kind: "unknown", why: `${children.length} bun processes under pane ${ref.id}` };
    if (inFront.length > 0) {
      const what = inFront[0]?.name !== "" ? inFront[0]?.name : `pid ${inFront[0]?.pid ?? "unknown"}`;
      return { kind: "unknown", why: `pane ${ref.id} foreground cannot be identified as its shell: ${what}` };
    }
    return { kind: "stopped" };
  }

  async close(ref: SessionRef): Promise<void> {
    try {
      if (ref.container !== undefined) await this.cli.call(["tab", "close", ref.container]);
      else await this.cli.call(["pane", "close", ref.id]);
    } catch (e) {
      if (e instanceof ToolError && /not.?found/i.test(e.message)) return;
      throw e;
    }
  }

  private async paneInfo(paneId: string): Promise<PaneInfo | undefined> {
    try {
      const info = asRow((await this.cli.call(["pane", "process-info", "--pane", paneId]))["process_info"]);
      if (info === undefined) return undefined;
      const shell = info["shell_pid"];
      const procs = info["foreground_processes"];
      return {
        ...(typeof shell === "number" && Number.isInteger(shell) && shell > 0 ? { shell } : {}),
        foreground: Array.isArray(procs) ? procs.map(toProcess) : [],
      };
    } catch {
      return undefined;
    }
  }

  private envFlags(): string[] {
    return Object.entries(this.options.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  }
}
