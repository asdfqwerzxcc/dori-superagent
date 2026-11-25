import type { RuntimeKind, SessionRef } from "../src/runtime/types.ts";
import { PaneUnits } from "../src/supervisors/pane-units.ts";
import type { PaneAdapter, PaneProbe, PendingPanes } from "../src/supervisors/panes.ts";
import { pref } from "./ops-panes-fixture.ts";

export const RUNNING: PaneProbe = { kind: "running", pid: 400 };
export const STOPPED: PaneProbe = { kind: "stopped" };

export type Script = (pane: string, poll: number) => PaneProbe;

export type ScriptedOptions = {
  readonly windowMs: number;
  readonly existing?: readonly SessionRef[];
  readonly attempts?: number;
  readonly budgetMs?: number;
  readonly failStart?: (pane: string) => boolean;
  readonly failClose?: (pane: string) => boolean;
  readonly pending?: PendingPanes;
  readonly kind?: RuntimeKind;
  readonly unknownWaitMs?: number;
  readonly openDelayMs?: number;
  readonly panesDelayMs?: number;
  readonly closeAttempts?: number;
  readonly log?: (line: string) => void;
  readonly advance?: (ms: number) => void;
};

export class ScriptedPanes implements PaneAdapter {
  readonly kind: RuntimeKind;
  readonly starts: { readonly pane: string; readonly at: number }[] = [];
  readonly closed: string[] = [];
  readonly opened: string[] = [];
  private readonly polls = new Map<string, number>();
  constructor(
    private readonly opts: ScriptedOptions,
    private readonly script: Script,
    private readonly clock: () => number,
  ) {
    this.kind = opts.kind ?? "herdr";
  }

  async ready(): Promise<void> {}
  async panes(): Promise<readonly SessionRef[]> {
    if (this.opts.panesDelayMs !== undefined) this.opts.advance?.(this.opts.panesDelayMs);
    const open = (id: string): boolean => !this.closed.includes(id);
    return [...(this.opts.existing ?? []).filter((r) => open(r.id)), ...this.opened.filter(open).map((id) => pref(id))];
  }
  async open(): Promise<SessionRef> {
    if (this.opts.openDelayMs !== undefined) this.opts.advance?.(this.opts.openDelayMs);
    let n = this.opened.length + 1;
    while ((this.opts.existing ?? []).some((r) => r.id === `p${n}`) || this.opened.includes(`p${n}`)) n += 1;
    const id = `p${n}`;
    this.opened.push(id);
    return pref(id);
  }
  async start(ref: SessionRef): Promise<void> {
    this.starts.push({ pane: ref.id, at: this.clock() });
    if (this.opts.failStart?.(ref.id) === true) throw new Error("pane refused the command");
  }
  async pid(ref: SessionRef): Promise<PaneProbe> {
    const n = (this.polls.get(ref.id) ?? 0) + 1;
    this.polls.set(ref.id, n);
    return this.script(ref.id, n);
  }
  async close(ref: SessionRef): Promise<void> {
    if (this.opts.failClose?.(ref.id) === true) throw new Error("pane close refused");
    this.closed.push(ref.id);
  }
}

export function placement(script: Script, opts: ScriptedOptions) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  const advance = (ms: number): void => {
    clock += ms;
  };
  const adapter = new ScriptedPanes({ ...opts, advance }, script, () => clock);
  const units = new PaneUnits({
    adapter,
    log: opts.log ?? ((line) => logs.push(line)),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    pidPollMs: 50,
    startWindowMs: opts.windowMs,
    startAttempts: opts.attempts ?? 3,
    retryBaseMs: 1_000,
    retryCapMs: 4_000,
    pidTimeoutMs: opts.budgetMs ?? 30_000,
    ...(opts.pending === undefined ? {} : { pending: opts.pending }),
    ...(opts.unknownWaitMs === undefined ? {} : { unknownWaitMs: opts.unknownWaitMs }),
    ...(opts.closeAttempts === undefined ? {} : { closeAttempts: opts.closeAttempts }),
  });
  return { adapter, advance, logs, sleeps, units };
}

export const startsOn = (adapter: ScriptedPanes, pane: string): number =>
  adapter.starts.filter((s) => s.pane === pane).length;
