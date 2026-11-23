import type { RuntimeKind, SessionRef } from "../runtime/types.ts";

/** One unit as the pane layer needs it: the pane title, the shell command line, and the argv pieces that identify its process. */
export type PaneUnit = {
  readonly name: string;
  readonly command: string;
  readonly marker: readonly string[];
};

/** Where a unit runs: its pane and the unit process the supervisor watches. */
export type PlacedUnit = { readonly pid: number; readonly pane: SessionRef };

/** What a pane says about its unit: running with a pid, stopped, or unreadable (never read as stopped). */
export type PaneProbe =
  | { readonly kind: "running"; readonly pid: number }
  | { readonly kind: "stopped" }
  | { readonly kind: "unknown"; readonly why: string };

/** Liveness could not be read: the unit must wait, never start a second copy. */
export class PaneUnknown extends Error {}
/** A pane refused to start the unit and would not close: opening another would duplicate it. */
export class PaneCloseFailed extends Error {}

/**
 * The runtime half of pane placement: one ops workspace (herdr) or label group (hc), one titled pane per unit. Adapters
 * speak their runtime's CLI; `PaneUnits` owns the dedup, reuse and close-on-failure rules above them.
 */
export interface PaneAdapter {
  readonly kind: RuntimeKind;
  /** Finds or creates the ops workspace; throws when the runtime is not usable. */
  ready(): Promise<void>;
  /** Every pane titled `name` in the ops workspace (whether its unit still runs or not). */
  panes(name: string): Promise<readonly SessionRef[]>;
  /** Opens a new titled pane in the ops workspace. */
  open(name: string): Promise<SessionRef>;
  /** Starts the unit's command line in the pane. */
  start(ref: SessionRef, command: string): Promise<void>;
  /** What runs in THIS pane; never another same-titled pane's process. */
  pid(ref: SessionRef, marker: readonly string[]): Promise<PaneProbe>;
  /** Closes the pane (its tab on herdr); a pane that is already gone is not an error. */
  close(ref: SessionRef): Promise<void>;
}

export type PaneUnitsOptions = {
  readonly adapter: PaneAdapter;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pidTimeoutMs?: number;
  readonly pidPollMs?: number;
  /** Close attempts before giving up; a unit is never duplicated after a failed close. */
  readonly closeAttempts?: number;
};

export const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/**
 * The placement rules shared by every runtime: a unit whose pane still has its process is adopted, never duplicated; a
 * pane whose unit died is reused; a pane that will not start the unit is closed (retried) and only then replaced. An
 * unreadable liveness or a failed close ends placement instead of starting a second copy.
 */
export class PaneUnits {
  constructor(private readonly o: PaneUnitsOptions) {}

  get kind(): RuntimeKind {
    return this.o.adapter.kind;
  }

  async place(unit: PaneUnit): Promise<PlacedUnit> {
    await this.o.adapter.ready();
    const found = await this.o.adapter.panes(unit.name);
    let stopped: SessionRef | undefined;
    let unknown: string | undefined;
    for (const ref of found) {
      const probe = await this.o.adapter.pid(ref, unit.marker);
      if (probe.kind === "running") return { pid: probe.pid, pane: ref };
      if (probe.kind === "unknown") unknown ??= probe.why;
      else stopped ??= ref;
    }
    if (unknown !== undefined) throw new PaneUnknown(`cannot tell whether ${unit.name} runs: ${unknown}`);
    if (stopped !== undefined) {
      const pid = await this.reuse(stopped, unit);
      if (pid !== undefined) return { pid, pane: stopped };
    }
    const fresh = await this.o.adapter.open(unit.name);
    try {
      await this.o.adapter.start(fresh, unit.command);
      const probe = await this.waitPid(fresh, unit.marker);
      if (probe.kind === "running") return { pid: probe.pid, pane: fresh };
      if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
      throw new Error(`no ${unit.name} process appeared in ${fresh.id}`);
    } catch (e) {
      // A pane whose liveness is unreadable may still hold the unit: closing it could kill it, and leaving it be is the
      // only way to be sure no second copy runs.
      if (!(e instanceof PaneUnknown)) await this.closeRetry(unit.name, fresh);
      throw e;
    }
  }

  /** Closes a unit's pane; the caller turns a throw into a warning. */
  close(ref: SessionRef): Promise<void> {
    return this.o.adapter.close(ref);
  }

  private async reuse(ref: SessionRef, unit: PaneUnit): Promise<number | undefined> {
    try {
      await this.o.adapter.start(ref, unit.command);
    } catch (e) {
      this.o.log(`SUPERVISED ${unit.name}_pane_start_failed reason=${oneLine(e)}`);
      if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
      return undefined;
    }
    const probe = await this.waitPid(ref, unit.marker);
    if (probe.kind === "running") return probe.pid;
    if (probe.kind === "unknown") throw new PaneUnknown(`cannot tell whether ${unit.name} started: ${probe.why}`);
    this.o.log(`SUPERVISED ${unit.name}_pane_start_failed reason=no ${unit.name} process appeared in ${ref.id}`);
    if (!(await this.closeRetry(unit.name, ref))) throw new PaneCloseFailed(`could not close ${ref.id}`);
    return undefined;
  }

  private async closeRetry(name: string, ref: SessionRef): Promise<boolean> {
    const attempts = Math.max(1, this.o.closeAttempts ?? 2);
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.o.adapter.close(ref);
        return true;
      } catch (e) {
        last = e;
      }
    }
    this.o.log(`SUPERVISED ${name}_pane_close_failed reason=${oneLine(last)}`);
    return false;
  }

  private async waitPid(ref: SessionRef, marker: readonly string[]): Promise<PaneProbe> {
    const deadline = Date.now() + (this.o.pidTimeoutMs ?? 10_000);
    for (;;) {
      const probe = await this.o.adapter.pid(ref, marker);
      if (probe.kind === "running") return probe;
      if (Date.now() >= deadline) return probe;
      await this.o.sleep(this.o.pidPollMs ?? 300);
    }
  }
}
