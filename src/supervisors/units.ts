import type { SessionRef } from "../runtime/types.ts";
import type { PlacedUnit } from "./panes.ts";
import { oneLine, PaneCloseFailed, PaneUnknown } from "./panes.ts";
import { printable } from "../unit-placement.ts";

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
  /** The unit is no longer in a pane but is not gone: clear just its recorded pane before the headless child starts. */
  readonly onUnplace?: () => void;
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
  const say = (line: string): void => {
    try {
      o.log(line);
    } catch {}
  };
  const poll = o.pollMs ?? 1_000;
  const restart = o.restartMs ?? 5_000;
  let unknownLogged = false;
  let closeHeldLogged = false;
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
          say(`SUPERVISED ${printable(o.name)}_pane_unknown reason=${printable(oneLine(e))}`);
          unknownLogged = true;
        }
        await o.sleep(poll);
        continue;
      }
      // A pane that was typed into and would not close may still run that line: wait for it instead of putting the unit
      // headless beside it. Placement will adopt the line if it starts, else close the pane and replace it.
      if (e instanceof PaneCloseFailed) {
        if (!closeHeldLogged) {
          say(`SUPERVISED ${printable(o.name)}_pane_close_held reason=${printable(oneLine(e))}`);
          closeHeldLogged = true;
        }
        await o.sleep(poll);
        continue;
      }
      say(`SUPERVISED ${printable(o.name)}_pane_fallback reason=${printable(oneLine(e))}`);
      // No unit runs in a pane any more: clear only the pane, so a headless child failing to start leaves the unit
      // recorded (dead) instead of unrecorded.
      o.onUnplace?.();
      return o.headless();
    }
    unknownLogged = false;
    closeHeldLogged = false;
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
      say(`SUPERVISED ${o.name}_stop pane=${placed.pane.id}`);
      try {
        await o.close(placed.pane);
      } catch (e) {
        say(`SUPERVISED ${printable(o.name)}_pane_close_failed reason=${printable(oneLine(e))}`);
      }
      continue;
    }
    say(`SUPERVISED ${o.name}_exit code=? pane=${placed.pane.id}`);
    await o.sleep(restart);
  }
}
