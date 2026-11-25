import { printable } from "../unit-placement.ts";
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
  private readonly unknownSince = new Map<string, number>();

  constructor(private readonly o: PaneUnitsOptions) {
    this.typed = new Set(o.pending?.read() ?? []);
  }

  get kind(): RuntimeKind {
    return this.o.adapter.kind;
  }

  async place(unit: PaneUnit): Promise<PlacedUnit> {
    await this.o.adapter.ready();
    const now = this.o.now ?? Date.now;
    const deadline = now() + (this.o.pidTimeoutMs ?? PID_BUDGET_MS);
    const attempts = this.attempts();
    const stopped: SessionRef[] = [];
    const doubtful: SessionRef[] = [];
    let unknown: string | undefined;
    for (const ref of await this.scan(unit.name)) {
      const probe = await this.probe(ref, unit);
      if (probe.kind === "running") {
        this.mark(ref.id, false);
        this.unknownSince.delete(unit.name);
        return { pid: probe.pid, pane: ref };
      }
      if (probe.kind === "unknown") {
        const hinted = this.hinted(probe, ref);
        if (hinted !== undefined) return hinted;
        doubtful.push(ref);
        unknown ??= probe.why;
      } else {
        stopped.push(ref);
      }
    }
    if (unknown !== undefined) {
      if (!(await this.clearDoubt(unit, doubtful, now()))) {
        throw new PaneUnknown(`cannot tell whether ${unit.name} runs: ${unknown}`);
      }
    } else {
      this.unknownSince.delete(unit.name);
    }
    // Every stopped pane the previous placement typed into may still hold that line: close them all, type into none.
    const closed = new Set<string>();
    for (const ref of stopped.filter((r) => this.typed.has(r.id))) {
      if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      closed.add(ref.id);
    }
    const reuse = stopped.find((r) => !closed.has(r.id) && !this.typed.has(r.id));
    let lines = 0;
    let tries = 0;
    let lastStart: unknown;
    if (reuse !== undefined) {
      tries = 1;
      try {
        this.mark(reuse.id, true);
        await this.o.adapter.start(reuse, unit.command);
        lines = 1;
      } catch (e) {
        lastStart = e;
        this.o.log(`SUPERVISED ${printable(unit.name)}_pane_start_failed reason=${printable(oneLine(e))}`);
        if (!(await this.closeRetry(unit.name, reuse))) throw new PaneCloseFailed(`could not close ${reuse.id}`);
      }
      if (lines === 1) {
        const probe = await this.settle(reuse, unit, deadline);
        if (probe.kind === "running") {
          this.mark(reuse.id, false);
          return { pid: probe.pid, pane: reuse };
        }
        const hinted = this.hinted(probe, reuse);
        if (hinted !== undefined) return hinted;
        if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
        this.o.log(
          `SUPERVISED ${printable(unit.name)}_pane_start_failed reason=no ${printable(unit.name)} process appeared in ${printable(reuse.id)} after 1 attempt`,
        );
        if (!(await this.closeRetry(unit.name, reuse))) throw new PaneCloseFailed(`could not close ${reuse.id}`);
      }
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
        if (!(await this.closeRetry(unit.name, fresh))) throw new PaneCloseFailed(`could not close ${fresh.id}`);
        break;
      }
      try {
        this.mark(fresh.id, true);
        await this.o.adapter.start(fresh, unit.command);
      } catch (e) {
        lastStart = e;
        this.o.log(`SUPERVISED ${printable(unit.name)}_pane_start_failed reason=${printable(oneLine(e))}`);
        if (!(await this.closeRetry(unit.name, fresh))) throw new PaneCloseFailed(`could not close ${fresh.id}`);
        continue;
      }
      lines += 1;
      const probe = await this.settle(fresh, unit, deadline);
      if (probe.kind === "running") {
        this.mark(fresh.id, false);
        return { pid: probe.pid, pane: fresh };
      }
      const hinted = this.hinted(probe, fresh);
      if (hinted !== undefined) return hinted;
      if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
      this.o.log(
        `SUPERVISED ${printable(unit.name)}_pane_start_failed reason=no ${printable(unit.name)} process appeared in ${printable(fresh.id)} after 1 attempt`,
      );
      if (!(await this.closeRetry(unit.name, fresh))) throw new PaneCloseFailed(`could not close ${fresh.id}`);
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

  /** A foreground pid the runtime cannot name is the unit when this supervisor's line is the one typed into that pane. */
  private hinted(probe: PaneProbe, ref: SessionRef): PlacedUnit | undefined {
    if (probe.kind !== "unknown" || probe.pid === undefined || !this.typed.has(ref.id)) return undefined;
    this.mark(ref.id, false);
    this.unknownSince.delete(ref.id);
    return { pid: probe.pid, pane: ref };
  }

  /** An unnamed hc foreground is doubt; after the bounded wait its pane is closed (no copy survives) and replaced. */
  private async clearDoubt(unit: PaneUnit, panes: readonly SessionRef[], now: number): Promise<boolean> {
    if (this.kind !== "hc" || panes.length === 0) return false;
    const since = this.unknownSince.get(unit.name) ?? now;
    this.unknownSince.set(unit.name, since);
    if (now - since < (this.o.unknownWaitMs ?? UNKNOWN_WAIT_MS)) return false;
    this.o.log(
      `SUPERVISED ${printable(unit.name)}_pane_doubt_closed panes=${panes.length} after=${Math.round((now - since) / 1000)}s`,
    );
    for (const ref of panes) {
      if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
    }
    this.unknownSince.delete(unit.name);
    return true;
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
  private async settle(ref: SessionRef, unit: PaneUnit, deadline: number): Promise<PaneProbe> {
    try {
      return await this.settled(ref, unit, deadline);
    } catch (e) {
      throw new PaneUnknown(`cannot read pane ${ref.id} after typing: ${oneLine(e)}`);
    }
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

  private attempts(): number {
    return Math.max(1, this.o.startAttempts ?? START_ATTEMPTS);
  }

  /** Waits for the typed line to match, bounded by its window and the deadline; the read before the close adopts a late unit. */
  private async settled(ref: SessionRef, unit: PaneUnit, deadline: number): Promise<PaneProbe> {
    const now = this.o.now ?? Date.now;
    const poll = this.o.pidPollMs ?? 300;
    const until = Math.min(now() + Math.max(0, this.o.startWindowMs ?? START_WINDOW_MS), deadline);
    let last: PaneProbe = { kind: "stopped" };
    for (;;) {
      last = await this.o.adapter.pid(ref, unit.marker, unit.program);
      if (last.kind !== "stopped") return last;
      if (now() >= until) break;
      const pause = Math.min(poll, until - now());
      if (pause > 0) await this.o.sleep(pause);
    }
    return this.o.adapter.pid(ref, unit.marker, unit.program);
  }
}
