import type { SessionRef } from "../runtime/types.ts";
import type { PlacedUnit } from "./panes.ts";
import { oneLine, PaneUnknown } from "./panes.ts";

/** The shell a pane's run/send types into: PowerShell on Windows herdr panes, sh everywhere hc runs. */
export type PaneShell = "powershell" | "sh";

const quote = (text: string, shell: PaneShell): string =>
  shell === "powershell" ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;

/**
 * One command line for a pane's shell, every argument quoted so a path with spaces stays one word. PowerShell needs the
 * call operator before a quoted path; sh takes the same words directly.
 */
export function paneCommand(bun: string, argv: readonly string[], shell: PaneShell): string {
  const words = [bun, ...argv].map((a) => quote(a, shell)).join(" ");
  return shell === "powershell" ? `& ${words}` : words;
}

export type RunUnitOptions = {
  readonly name: string;
  readonly place: () => Promise<PlacedUnit>;
  readonly close: (pane: SessionRef) => Promise<void>;
  readonly headless: () => Promise<never>;
  readonly onStart: (placed: PlacedUnit) => void;
  readonly onExit: () => void;
  readonly alive: (pid: number) => boolean;
  readonly enabled?: () => boolean;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs?: number;
  readonly restartMs?: number;
};

/**
 * The pane half of one unit's supervisor loop: place the unit, watch its pid, and place it again after it dies. A
 * placement failure falls back to the headless loop with one warning; a disabled plugin's pane is closed and waits.
 */
export async function runUnitInPane(o: RunUnitOptions): Promise<never> {
  const poll = o.pollMs ?? 1_000;
  const restart = o.restartMs ?? 5_000;
  let unknownLogged = false;
  for (;;) {
    if (o.enabled !== undefined && !o.enabled()) {
      await o.sleep(poll);
      continue;
    }
    let placed: PlacedUnit;
    try {
      placed = await o.place();
    } catch (e) {
      // An unreadable process list is not a dead unit: retry placement instead of starting a headless second copy.
      if (e instanceof PaneUnknown) {
        if (!unknownLogged) {
          o.log(`SUPERVISED ${o.name}_pane_unknown reason=${oneLine(e)}`);
          unknownLogged = true;
        }
        await o.sleep(poll);
        continue;
      }
      o.log(`SUPERVISED ${o.name}_pane_fallback reason=${oneLine(e)}`);
      return o.headless();
    }
    unknownLogged = false;
    o.onStart(placed);
    let stopped = false;
    while (o.alive(placed.pid)) {
      await o.sleep(poll);
      if (o.enabled !== undefined && !o.enabled()) {
        stopped = true;
        break;
      }
    }
    o.onExit();
    if (stopped) {
      o.log(`SUPERVISED ${o.name}_stop pane=${placed.pane.id}`);
      try {
        await o.close(placed.pane);
      } catch (e) {
        o.log(`SUPERVISED ${o.name}_pane_close_failed reason=${oneLine(e)}`);
      }
      continue;
    }
    o.log(`SUPERVISED ${o.name}_exit code=? pane=${placed.pane.id}`);
    await o.sleep(restart);
  }
}
