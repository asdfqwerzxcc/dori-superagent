import type { RuntimeKind, SessionRef } from "../runtime/types.ts";
import { printable } from "../unit-placement.ts";
import { PaneCloseFailed, PaneUnknown, type PaneProbe, type PendingPanes } from "./panes.ts";

export type SettleOptions = {
  readonly probe: (ref: SessionRef, marker: readonly string[], program?: string) => Promise<PaneProbe>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
  readonly windowMs: number;
};

/**
 * Waits for a typed line to become the unit, bounded by its window and (after the first line) the placement deadline. The
 * read after the last pause is the one that can adopt a late unit just before its pane is closed. A read failure is
 * doubt, not a dead unit: the typed line may still run.
 */
export async function settleLine(
  o: SettleOptions,
  ref: SessionRef,
  marker: readonly string[],
  program: string | undefined,
  deadline: number,
  first: boolean,
): Promise<PaneProbe> {
  try {
    const window = o.now() + Math.max(0, o.windowMs);
    const until = first ? window : Math.min(window, deadline);
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

/**
 * An unnamed hc foreground is doubt; after the bounded wait its panes are closed and replaced. The line is logged only
 * after every close succeeds, so a retry cannot log it twice.
 */
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
  for (const ref of panes) {
    if (!(await o.close(ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
  }
  timers.delete(unit);
  try {
    o.log(
      `SUPERVISED ${printable(unit)}_pane_doubt_closed panes=${panes.length} after=${Math.round((o.now - since) / 1000)}s`,
    );
  } catch {}
  return true;
}

export type LedgerOptions = {
  readonly pending?: PendingPanes | undefined;
  readonly close: (ref: SessionRef) => Promise<void>;
  readonly log: (line: string) => void;
  readonly closeAttempts: number;
};

/** The typed-pane set and its disk copy: every id in it may still hold a pending line. */
export class PaneLedger {
  private readonly typed: Set<string>;
  private readonly unreadable: boolean;
  constructor(private readonly o: LedgerOptions) {
    const loaded = o.pending?.read();
    this.typed = new Set(loaded ?? []);
    this.unreadable = o.pending !== undefined && loaded === undefined;
  }
  log(line: string): void {
    try {
      this.o.log(line);
    } catch {}
  }
  has(id: string): boolean {
    return this.typed.has(id);
  }
  /** True when a stopped pane may hold a line: typed here, or the store could not tell. */
  protected(id: string): boolean {
    return this.typed.has(id) || this.unreadable;
  }
  mark(id: string, typed: boolean): void {
    if (typed) this.typed.add(id);
    else this.typed.delete(id);
    try {
      this.o.pending?.write([...this.typed]);
    } catch {}
  }
  async closeRetry(name: string, ref: SessionRef): Promise<boolean> {
    let last: unknown;
    for (let attempt = 0; attempt < this.o.closeAttempts; attempt++) {
      try {
        await this.o.close(ref);
        this.mark(ref.id, false);
        return true;
      } catch (e) {
        last = e;
      }
    }
    try {
      this.o.log(`SUPERVISED ${printable(name)}_pane_close_failed reason=${printable(String(last))}`);
    } catch {}
    return false;
  }
}
