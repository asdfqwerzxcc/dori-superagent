import type { RuntimeKind, SessionRef } from "../runtime/types.ts";

/** One unit as the pane layer needs it: the pane title, the shell command line, and the argv pieces that identify its process. */
export type PaneUnit = {
  readonly name: string;
  readonly command: string;
  readonly marker: readonly string[];
};

/** Where a unit runs: its pane and the unit process the supervisor watches. */
export type PlacedUnit = { readonly pid: number; readonly pane: SessionRef };

/**
 * The runtime half of pane placement: one ops workspace (herdr) or label group (hc), one titled pane per unit. Adapters
 * speak their runtime's CLI; `PaneUnits` owns the dedup, reuse and close-on-failure rules above them.
 */
export interface PaneAdapter {
  readonly kind: RuntimeKind;
  /** Finds or creates the ops workspace; throws when the runtime is not usable. */
  ready(): Promise<void>;
  /** The pane titled `name` in the ops workspace, if one exists (whether its unit still runs or not). */
  find(name: string): Promise<SessionRef | undefined>;
  /** Opens a new titled pane in the ops workspace. */
  open(name: string): Promise<SessionRef>;
  /** Starts the unit's command line in the pane. */
  start(ref: SessionRef, command: string): Promise<void>;
  /** The live unit pid in the pane for this marker, or undefined when the pane has no such process. */
  pid(ref: SessionRef, marker: readonly string[]): Promise<number | undefined>;
  /** Closes the pane (its tab on herdr); a pane that is already gone is not an error. */
  close(ref: SessionRef): Promise<void>;
}

export type PaneUnitsOptions = {
  readonly adapter: PaneAdapter;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pidTimeoutMs?: number;
  readonly pidPollMs?: number;
};

export const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

/**
 * The placement rules shared by every runtime: a unit whose pane still has its process is adopted, never duplicated; a
 * pane whose unit died is reused; a pane that will not start the unit is closed (a failed close is one warning) and
 * replaced by a new one.
 */
export class PaneUnits {
  constructor(private readonly o: PaneUnitsOptions) {}

  get kind(): RuntimeKind {
    return this.o.adapter.kind;
  }

  async place(unit: PaneUnit): Promise<PlacedUnit> {
    await this.o.adapter.ready();
    const found = await this.o.adapter.find(unit.name);
    if (found !== undefined) {
      const live = await this.o.adapter.pid(found, unit.marker);
      if (live !== undefined) return { pid: live, pane: found };
      const pid = await this.reuse(found, unit);
      if (pid !== undefined) return { pid, pane: found };
    }
    const fresh = await this.o.adapter.open(unit.name);
    try {
      await this.o.adapter.start(fresh, unit.command);
      const pid = await this.waitPid(fresh, unit.marker);
      if (pid === undefined) throw new Error(`no ${unit.name} process appeared in ${fresh.id}`);
      return { pid, pane: fresh };
    } catch (e) {
      await this.closeWarn(unit.name, fresh);
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
      const pid = await this.waitPid(ref, unit.marker);
      if (pid === undefined) throw new Error(`no ${unit.name} process appeared in ${ref.id}`);
      return pid;
    } catch (e) {
      this.o.log(`SUPERVISED ${unit.name}_pane_start_failed reason=${oneLine(e)}`);
      await this.closeWarn(unit.name, ref);
      return undefined;
    }
  }

  private async closeWarn(name: string, ref: SessionRef): Promise<void> {
    try {
      await this.o.adapter.close(ref);
    } catch (e) {
      this.o.log(`SUPERVISED ${name}_pane_close_failed reason=${oneLine(e)}`);
    }
  }

  private async waitPid(ref: SessionRef, marker: readonly string[]): Promise<number | undefined> {
    const deadline = Date.now() + (this.o.pidTimeoutMs ?? 10_000);
    for (;;) {
      const pid = await this.o.adapter.pid(ref, marker);
      if (pid !== undefined) return pid;
      if (Date.now() >= deadline) return undefined;
      await this.o.sleep(this.o.pidPollMs ?? 300);
    }
  }
}
