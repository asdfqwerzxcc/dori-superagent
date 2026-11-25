import { printable } from "../unit-placement.ts";
import { clearDoubtPanes, PaneLedger, settleLine } from "./pane-settle.ts";
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
  private readonly unknownSince = new Map<string, { readonly since: number; readonly ids: string }>();
  private readonly ledger: PaneLedger;

  constructor(private readonly o: PaneUnitsOptions) {
    this.ledger = new PaneLedger({
      pending: o.pending,
      close: (ref) => o.adapter.close(ref),
      log: o.log,
      closeAttempts: Math.max(1, o.closeAttempts ?? 2),
    });
  }

  get kind(): RuntimeKind {
    return this.o.adapter.kind;
  }

  async place(unit: PaneUnit): Promise<PlacedUnit> {
    try {
      await this.o.adapter.ready();
    } catch (e) {
      // A pending line may still run: readiness failure is doubt, never a reason to start a headless copy beside it.
      if (this.ledger.mayHavePending()) throw new PaneUnknown(`cannot ready the runtime: ${oneLine(e)}`);
      throw e;
    }
    const now = this.o.now ?? Date.now;
    const deadline = now() + (this.o.pidTimeoutMs ?? PID_BUDGET_MS);
    const attempts = Math.max(1, this.o.startAttempts ?? START_ATTEMPTS);
    const stopped: SessionRef[] = [];
    const doubtful: SessionRef[] = [];
    const hints: PlacedUnit[] = [];
    const namedList: PlacedUnit[] = [];
    let unknown: string | undefined;
    for (const ref of await this.scan(unit.name)) {
      const probe = await this.probe(ref, unit);
      if (probe.kind === "running") namedList.push({ pid: probe.pid, pane: ref });
      else if (probe.kind === "unknown") {
        const pid = this.hinted(probe, ref);
        if (pid === undefined) {
          doubtful.push(ref);
          unknown ??= probe.why;
        } else hints.push({ pid, pane: ref });
      } else stopped.push(ref);
    }
    // Every stopped pane a previous placement typed into, and every hinted pane this one will not adopt, may still
    // hold a pending line: close them all before any pane is chosen, so no later line starts as an untracked copy.
    const protectedPane = (id: string): boolean => this.ledger.protected(id);
    const closed = new Set<string>();
    const named = namedList[0];
    const leftovers = named === undefined ? hints.slice(1) : [...hints, ...namedList.slice(1)];
    for (const ref of [...stopped.filter((r) => protectedPane(r.id)), ...leftovers.map((h) => h.pane)]) {
      if (!(await this.ledger.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      closed.add(ref.id);
    }
    if (named !== undefined || hints[0] !== undefined) {
      await this.resolveDoubt(unit, doubtful);
      const placed = named ?? hints[0];
      if (placed === undefined) throw new Error("unreachable");
      // A hinted pane stays in the set so a restarted supervisor adopts the unnamed hc unit again instead of closing it.
      this.ledger.mark(placed.pane.id, named === undefined);
      this.unknownSince.delete(unit.name);
      return placed;
    }
    if (unknown !== undefined) {
      if (!(await this.clearDoubt(unit, doubtful, now()))) {
        throw new PaneUnknown(`cannot tell whether ${unit.name} runs: ${unknown}`);
      }
    } else {
      this.unknownSince.delete(unit.name);
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
      const outcome = await this.startIn(unit, reuse, deadline, true);
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
        await this.ledger.closeRetry(unit.name, fresh);
        break;
      }
      const outcome = await this.startIn(unit, fresh, deadline, lines === 0);
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
    throw new Error(`no ${unit.name} process appeared after ${tries} attempt${tries === 1 ? "" : "s"}`);
  }

  /** Closes a unit's pane; the caller turns a throw into a warning. */
  async close(ref: SessionRef): Promise<void> {
    await this.o.adapter.close(ref);
    this.ledger.mark(ref.id, false);
  }

  /** The foreground pid of a pane this supervisor typed into, which the runtime cannot name; the caller adopts it. */
  private hinted(probe: PaneProbe, ref: SessionRef): number | undefined {
    if (this.kind !== "hc" || probe.kind !== "unknown" || probe.pid === undefined || !this.ledger.has(ref.id))
      return undefined;
    return probe.pid;
  }

  private clearDoubt(unit: PaneUnit, panes: readonly SessionRef[], now: number): Promise<boolean> {
    return clearDoubtPanes(
      {
        kind: this.kind,
        waitMs: this.o.unknownWaitMs ?? UNKNOWN_WAIT_MS,
        now,
        log: this.o.log,
        close: (ref) => this.ledger.closeRetry(unit.name, ref),
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
  private settle(ref: SessionRef, unit: PaneUnit, deadline: number, first: boolean): Promise<PaneProbe> {
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
      first,
    );
  }

  /** Types one line and waits for it; a refusal closes the pane, a death closes it, an unreadable read is doubt. */
  private async startIn(
    unit: PaneUnit,
    ref: SessionRef,
    deadline: number,
    first: boolean,
  ): Promise<{ readonly placed?: PlacedUnit; readonly typed: boolean; readonly failure?: unknown }> {
    try {
      this.ledger.mark(ref.id, true);
      await this.o.adapter.start(ref, unit.command);
    } catch (e) {
      this.ledger.log(`SUPERVISED ${printable(unit.name)}_pane_start_failed reason=${printable(oneLine(e))}`);
      if (!(await this.ledger.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      return { typed: false, failure: e };
    }
    const probe = await this.settle(ref, unit, deadline, first);
    if (probe.kind === "running") {
      this.ledger.mark(ref.id, false);
      return { placed: { pid: probe.pid, pane: ref }, typed: true };
    }
    const pid = this.hinted(probe, ref);
    if (pid !== undefined) {
      this.ledger.mark(ref.id, true);
      this.unknownSince.delete(unit.name);
      return { placed: { pid, pane: ref }, typed: true };
    }
    if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
    this.ledger.log(
      `SUPERVISED ${printable(unit.name)}_pane_start_failed reason=no ${printable(unit.name)} process appeared in ${printable(ref.id)} after 1 attempt`,
    );
    if (!(await this.ledger.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
    return { typed: true };
  }
  private async resolveDoubt(unit: PaneUnit, panes: readonly SessionRef[]): Promise<void> {
    if (panes.length === 0) return;
    if (this.kind !== "hc") {
      this.ledger.log(`SUPERVISED ${printable(unit.name)}_pane_doubt_left panes=${panes.length}`);
      return;
    }
    for (const ref of panes) {
      if (!(await this.ledger.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
    }
    this.unknownSince.delete(unit.name);
  }
}
