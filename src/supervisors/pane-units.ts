import { printable } from "../unit-placement.ts";
import { clearDoubtPanes, settleLine } from "./pane-settle.ts";
import type { RuntimeKind, SessionRef } from "../runtime/types.ts";
import {
  oneLine,
  PaneCloseFailed,
  PaneUnknown,
  type PaneProbe,
  type PaneUnit,
  type PaneUnitsOptions,
  type PlacedUnit,
} from "./panes.ts";

/** The first line gets the old wait's budget (10 s); later lines are bounded by what is left of the placement budget. */
const START_WINDOW_MS = 10_000;
const START_ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 4_000;
const PID_BUDGET_MS = 30_000;
const UNKNOWN_WAIT_MS = 10_000;

/**
 * Adopt a live unit, reuse a dead unit's pane, and never type twice into one shell: the typed set persists across a
 * supervisor restart. Close failures and probe failures after typing wait instead of falling back headless; an unnamed
 * hc pane is closed after a bounded wait rather than suppressing its unit forever.
 */
export class PaneUnits {
  private readonly typed: Set<string>;
  private readonly pendingUnreadable: boolean;
  private readonly unknownSince = new Map<string, number>();

  constructor(private readonly o: PaneUnitsOptions) {
    const loaded = o.pending?.read();
    this.typed = new Set(loaded ?? []);
    this.pendingUnreadable = o.pending !== undefined && loaded === undefined;
  }

  get kind(): RuntimeKind {
    return this.o.adapter.kind;
  }

  async place(unit: PaneUnit): Promise<PlacedUnit> {
    await this.o.adapter.ready();
    const now = this.o.now ?? Date.now;
    const deadline = now() + (this.o.pidTimeoutMs ?? PID_BUDGET_MS);
    const attempts = Math.max(1, this.o.startAttempts ?? START_ATTEMPTS);
    const stopped: SessionRef[] = [];
    const doubtful: SessionRef[] = [];
    let hint: PlacedUnit | undefined;
    let unknown: string | undefined;
    for (const ref of await this.scan(unit.name)) {
      const probe = await this.probe(ref, unit);
      if (probe.kind === "running") {
        // The named pane wins; a hinted leftover must not keep a second copy of the unit.
        if (hint !== undefined) await this.closeRetry(unit.name, hint.pane);
        this.mark(ref.id, false);
        this.unknownSince.delete(unit.name);
        return { pid: probe.pid, pane: ref };
      }
      if (probe.kind === "unknown") {
        const pid = this.hinted(probe, ref);
        if (pid !== undefined) hint ??= { pid, pane: ref };
        else {
          doubtful.push(ref);
          unknown ??= probe.why;
        }
      } else {
        stopped.push(ref);
      }
    }
    if (hint !== undefined) {
      this.mark(hint.pane.id, false);
      this.unknownSince.delete(unit.name);
      return hint;
    }
    if (unknown !== undefined) {
      if (!(await this.clearDoubt(unit, doubtful, now()))) {
        throw new PaneUnknown(`cannot tell whether ${unit.name} runs: ${unknown}`);
      }
    } else {
      this.unknownSince.delete(unit.name);
    }
    // Every stopped pane the previous placement typed into may still hold that line: close them all, type into none.
    const protectedPane = (id: string): boolean => this.typed.has(id) || this.pendingUnreadable;
    const closed = new Set<string>();
    for (const ref of stopped.filter((r) => protectedPane(r.id))) {
      if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      closed.add(ref.id);
    }
    const reuse = stopped.find((r) => !closed.has(r.id) && !protectedPane(r.id));
    let lines = 0;
    let tries = 0;
    let lastStart: unknown;
    if (reuse !== undefined && now() >= deadline) {
      throw new Error(`no ${unit.name} process appeared: the placement budget ran out before a line was typed`);
    }
    if (reuse !== undefined) {
      tries = 1;
      const outcome = await this.startIn(unit, reuse, deadline);
      if (outcome.placed !== undefined) return outcome.placed;
      if (outcome.typed) lines = 1;
      else lastStart = outcome.failure;
    }
    const cap = Math.max(0, this.o.retryCapMs ?? RETRY_CAP_MS);
    let delay = Math.min(Math.max(0, this.o.retryBaseMs ?? RETRY_BASE_MS), cap);
    while (tries < attempts) {
      if (tries > 0) {
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await this.o.sleep(Math.min(delay, remaining));
        delay = Math.min(delay * 2, cap);
        if (now() >= deadline) break;
      }
      tries += 1;
      const fresh = await this.o.adapter.open(unit.name);
      if (now() >= deadline) {
        // Nothing was typed here: a pane that will not close is an empty leftover, not a pending unit.
        await this.closeRetry(unit.name, fresh);
        break;
      }
      const outcome = await this.startIn(unit, fresh, deadline);
      if (outcome.placed !== undefined) return outcome.placed;
      if (outcome.typed) lines += 1;
      else lastStart = outcome.failure;
    }
    if (lines === 0) {
      throw new Error(
        lastStart === undefined
          ? `no ${unit.name} process appeared: the placement budget ran out before a line was typed`
          : `no ${unit.name} process appeared: every start was refused (${oneLine(lastStart)})`,
      );
    }
    throw new Error(`no ${unit.name} process appeared after ${lines === 1 ? "1 attempt" : `${lines} attempts`}`);
  }

  /** Closes a unit's pane; the caller turns a throw into a warning. */
  async close(ref: SessionRef): Promise<void> {
    await this.o.adapter.close(ref);
    this.mark(ref.id, false);
  }

  /** The foreground pid of a pane this supervisor typed into, which the runtime cannot name; the caller adopts it. */
  private hinted(probe: PaneProbe, ref: SessionRef): number | undefined {
    if (probe.kind !== "unknown" || probe.pid === undefined || !this.typed.has(ref.id)) return undefined;
    return probe.pid;
  }

  private clearDoubt(unit: PaneUnit, panes: readonly SessionRef[], now: number): Promise<boolean> {
    return clearDoubtPanes(
      {
        kind: this.kind,
        waitMs: this.o.unknownWaitMs ?? UNKNOWN_WAIT_MS,
        now,
        log: this.o.log,
        close: (ref) => this.closeRetry(unit.name, ref),
      },
      unit.name,
      panes,
      this.unknownSince,
    );
  }

  private async scan(name: string): Promise<readonly SessionRef[]> {
    try {
      return await this.o.adapter.panes(name);
    } catch (e) {
      throw new PaneUnknown(`cannot list the panes of ${name}: ${oneLine(e)}`);
    }
  }

  private async probe(ref: SessionRef, unit: PaneUnit): Promise<PaneProbe> {
    try {
      return await this.o.adapter.pid(ref, unit.marker, unit.program);
    } catch (e) {
      return { kind: "unknown", why: `cannot read pane ${ref.id}: ${oneLine(e)}` };
    }
  }

  /** A throw while reading the pane after typing is doubt, not a dead unit: the typed line may still run. */
  private settle(ref: SessionRef, unit: PaneUnit, deadline: number): Promise<PaneProbe> {
    return settleLine(
      {
        probe: (r, marker, program) => this.o.adapter.pid(r, marker, program),
        now: this.o.now ?? Date.now,
        sleep: this.o.sleep,
        pollMs: this.o.pidPollMs ?? 300,
        windowMs: this.o.startWindowMs ?? START_WINDOW_MS,
      },
      ref,
      unit.marker,
      unit.program,
      deadline,
    );
  }

  /** Types one line and waits for it; a refusal closes the pane, a death closes it, an unreadable read is doubt. */
  private async startIn(
    unit: PaneUnit,
    ref: SessionRef,
    deadline: number,
  ): Promise<{ readonly placed?: PlacedUnit; readonly typed: boolean; readonly failure?: unknown }> {
    try {
      this.mark(ref.id, true);
      await this.o.adapter.start(ref, unit.command);
    } catch (e) {
      this.o.log(`SUPERVISED ${printable(unit.name)}_pane_start_failed reason=${printable(oneLine(e))}`);
      if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      return { typed: false, failure: e };
    }
    const probe = await this.settle(ref, unit, deadline);
    if (probe.kind === "running") {
      this.mark(ref.id, false);
      return { placed: { pid: probe.pid, pane: ref }, typed: true };
    }
    const pid = this.hinted(probe, ref);
    if (pid !== undefined) {
      this.mark(ref.id, false);
      this.unknownSince.delete(unit.name);
      return { placed: { pid, pane: ref }, typed: true };
    }
    if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
    this.o.log(
      `SUPERVISED ${printable(unit.name)}_pane_start_failed reason=no ${printable(unit.name)} process appeared in ${printable(ref.id)} after 1 attempt`,
    );
    if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
    return { typed: true };
  }

  private mark(id: string, typed: boolean): void {
    if (typed) this.typed.add(id);
    else this.typed.delete(id);
    this.o.pending?.write([...this.typed]);
  }

  private async closeRetry(name: string, ref: SessionRef): Promise<boolean> {
    const attempts = Math.max(1, this.o.closeAttempts ?? 2);
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.o.adapter.close(ref);
        this.mark(ref.id, false);
        return true;
      } catch (e) {
        last = e;
      }
    }
    this.o.log(`SUPERVISED ${printable(name)}_pane_close_failed reason=${printable(oneLine(last))}`);
    return false;
  }
}
