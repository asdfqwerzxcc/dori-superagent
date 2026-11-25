import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../runtime/exec.ts";
import { ConfigError, RuntimeChoiceError, readRuntimeChoice } from "../runtime/select.ts";
import type { RuntimeKind } from "../runtime/types.ts";
import { stateDir } from "../supervisors.ts";
import { PaneUnits } from "./pane-units.ts";
import { oneLine, type PendingPanes } from "./panes.ts";
import { HcPanes } from "./panes-hc.ts";
import { HerdrPanes } from "./panes-herdr.ts";
import type { PaneShell } from "./units.ts";

/** The pane layer the supervisor uses, and the shell its command lines are quoted for. */
export type UnitPanes = { readonly units: PaneUnits; readonly shell: PaneShell };

/** The supervisor's own DORI vars, which a pane does not inherit: its shell belongs to the herdr/hc server, not to us. */
function paneEnv(home: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key.startsWith("DORI_") && value !== undefined) out[key] = value;
  out["DORI_HOME"] = home;
  out["DORI_VERIFY_PROMPT"] = "1";
  return out;
}

export type OpenUnitPanesOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly exec?: Exec;
  readonly session?: string;
  readonly exists?: (path: string) => boolean;
  readonly shell?: PaneShell;
};

/**
 * Typed pane ids on disk: a supervisor restarted in the middle of a 10 s start window must still know which pane holds a
 * pending line. A missing file is an empty set; an unreadable or malformed file reads as undefined, so placement treats
 * every stopped pane as possibly pending instead of typing over it. Writes use a temp file and a rename, so a crash never
 * leaves a truncated set; a failure is logged and placement keeps going.
 */
export function panePendingStore(home: string, warn?: (line: string) => void): PendingPanes {
  const dir = stateDir(home);
  const path = join(dir, "panes-pending.json");
  const failed = (what: string, e: unknown): void => {
    warn?.(`SUPERVISED panes_pending_${what} reason=${oneLine(e)}`);
  };
  return {
    read: () => {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        failed("unreadable", e);
        return undefined;
      }
      try {
        const raw: unknown = JSON.parse(text);
        if (!Array.isArray(raw)) throw new Error("not a list");
        return raw.filter((id): id is string => typeof id === "string");
      } catch (e) {
        failed("unreadable", e);
        return undefined;
      }
    },
    write: (ids) => {
      const tmp = `${path}.tmp`;
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(tmp, `${JSON.stringify(ids)}\n`);
        renameSync(tmp, path);
      } catch (e) {
        failed("write_failed", e);
      }
    },
  };
}

/**
 * The pane layer when the chosen runtime answers, else undefined after one warning line: a missing runtime (or a broken
 * config) never stops the supervisor, it keeps the headless children it always had. The runtime is the same choice
 * `dori up` makes; herdr and hc share the placement contract above this factory.
 */
export async function openUnitPanes(o: OpenUnitPanesOptions): Promise<UnitPanes | undefined> {
  let kind: RuntimeKind;
  try {
    kind = readRuntimeChoice({
      env: o.env,
      configPath: join(o.home, "config.json"),
      ...(o.exists === undefined ? {} : { exists: o.exists }),
    }).kind;
  } catch (e) {
    if (!(e instanceof RuntimeChoiceError || e instanceof ConfigError)) throw e;
    o.log(`SUPERVISED panes_unavailable reason=${oneLine(e)} headless=1`);
    return undefined;
  }
  const env = paneEnv(o.home, o.env);
  const adapter =
    kind === "hc"
      ? new HcPanes({
          home: o.home,
          env,
          sleep: o.sleep,
          log: o.log,
          ...(o.exec === undefined ? {} : { exec: o.exec }),
        })
      : new HerdrPanes({
          home: o.home,
          env,
          ...(o.exec === undefined ? {} : { exec: o.exec }),
          ...(o.session === undefined ? {} : { session: o.session }),
        });
  try {
    await adapter.ready();
  } catch (e) {
    o.log(`SUPERVISED panes_unavailable runtime=${kind} reason=${oneLine(e)} headless=1`);
    return undefined;
  }
  o.log(`SUPERVISED panes ready runtime=${kind}`);
  return {
    units: new PaneUnits({ adapter, log: o.log, sleep: o.sleep, pending: panePendingStore(o.home, o.log) }),
    shell: o.shell ?? (kind === "hc" || process.platform !== "win32" ? "sh" : "powershell"),
  };
}
