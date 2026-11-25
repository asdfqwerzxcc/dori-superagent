import type { RuntimeKind, SessionRef } from "../runtime/types.ts";

/**
 * One unit as the pane layer needs it: the pane title, the shell command line, the argv pieces that identify its
 * process, and the executable it runs as.
 */
export type PaneUnit = {
  readonly name: string;
  readonly command: string;
  readonly marker: readonly string[];
  /** The unit's interpreter (the supervisor's own executable); kept for adapters that can use it. */
  readonly program?: string;
};

/** Where a unit runs: its pane and the unit process the supervisor watches. */
export type PlacedUnit = { readonly pid: number; readonly pane: SessionRef };

/** What a pane says about its unit: running with a pid, stopped, or unreadable (never read as stopped). */
export type PaneProbe =
  | { readonly kind: "running"; readonly pid: number }
  | { readonly kind: "stopped" }
  /** `pid` is the foreground process the runtime sees but cannot name: a hint only for a pane this supervisor typed into. */
  | { readonly kind: "unknown"; readonly why: string; readonly pid?: number };

/** Liveness could not be read: the unit must wait, never start a second copy. */
export class PaneUnknown extends Error {}
/**
 * A pane was typed into and would not close. Its pending line may still run, so the unit must wait for the pane to go
 * and never start a headless copy beside it.
 */
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
  /** What runs in THIS pane; never another same-titled pane's process. `program` is the unit's interpreter. */
  pid(ref: SessionRef, marker: readonly string[], program?: string): Promise<PaneProbe>;
  /** Closes the pane (its tab on herdr); a pane that is already gone is not an error. */
  close(ref: SessionRef): Promise<void>;
}

/** Pane ids with a typed line that has not become the unit yet; kept across a supervisor restart. */
export type PendingPanes = {
  readonly read: () => readonly string[];
  readonly write: (ids: readonly string[]) => void;
};

export type PaneUnitsOptions = {
  readonly adapter: PaneAdapter;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** One placement's whole budget across reuse and every fresh pane; no line after the first is typed past it. */
  readonly pidTimeoutMs?: number;
  readonly pidPollMs?: number;
  /** How long one typed command line is given to become the pane's process. */
  readonly startWindowMs?: number;
  /** Start attempts per placement, the reused pane included; each later one goes into a fresh pane. */
  readonly startAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryCapMs?: number;
  /** Test seam: the clock the placement budget and the backoff windows read. */
  readonly now?: () => number;
  /** Close attempts before giving up; a unit is never duplicated after a failed close. */
  readonly closeAttempts?: number;
  /** Where typed panes are remembered; a restart loads them so a pending line is never typed over. */
  readonly pending?: PendingPanes;
  /** How long an hc pane whose foreground cannot be named is doubted before it is closed and replaced (default 10 s). */
  readonly unknownWaitMs?: number;
};

export const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
