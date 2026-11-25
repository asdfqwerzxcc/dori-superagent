import type { RuntimeKind, SessionRef } from "../runtime/types.ts";
import { PaneCloseFailed, PaneUnknown, type PaneProbe } from "./panes.ts";
import { printable } from "../unit-placement.ts";

export type SettleOptions = {
  readonly probe: (ref: SessionRef, marker: readonly string[], program?: string) => Promise<PaneProbe>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly windowMs: number;
};

/**
 * Waits for a typed line to become the unit, bounded by its window and the placement deadline. The read after the last
 * pause is the one that can adopt a late unit just before its pane is closed. A read failure is doubt, not a dead unit:
 * the typed line may still run.
 */
export async function settleLine(
  o: SettleOptions,
  ref: SessionRef,
  marker: readonly string[],
  program: string | undefined,
  deadline: number,
): Promise<PaneProbe> {
  try {
    const until = Math.min(o.now() + Math.max(0, o.windowMs), deadline);
    let last: PaneProbe = { kind: "stopped" };
    for (;;) {
      last = await o.probe(ref, marker, program);
      if (last.kind !== "stopped") return last;
      if (o.now() >= until) break;
      const pause = Math.min(o.pollMs, until - o.now());
      if (pause > 0) await o.sleep(pause);
    }
    return await o.probe(ref, marker, program);
  } catch (e) {
    throw new PaneUnknown(`cannot read pane ${ref.id} after typing: ${String(e)}`);
  }
}

export type DoubtOptions = {
  readonly kind: RuntimeKind;
  readonly waitMs: number;
  readonly now: number;
  readonly log: (line: string) => void;
  readonly close: (ref: SessionRef) => Promise<boolean>;
};

/** An unnamed hc foreground is doubt; after the bounded wait its panes are closed and replaced. */
export async function clearDoubtPanes(
  o: DoubtOptions,
  unit: string,
  panes: readonly SessionRef[],
  timers: Map<string, number>,
): Promise<boolean> {
  if (o.kind !== "hc" || panes.length === 0) return false;
  const since = timers.get(unit) ?? o.now;
  timers.set(unit, since);
  if (o.now - since < o.waitMs) return false;
  o.log(
    `SUPERVISED ${printable(unit)}_pane_doubt_closed panes=${panes.length} after=${Math.round((o.now - since) / 1000)}s`,
  );
  for (const ref of panes) {
    if (!(await o.close(ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
  }
  timers.delete(unit);
  return true;
}
