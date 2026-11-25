import { isPluginEnabled } from "./plugins/state.ts";
import { pluginRunEntry } from "./plugins/plugin.ts";
import { pidAlive } from "./process-liveness.ts";
import {
  ensureSupervisors,
  recordedAlive,
  spawnDetached,
  strictRecordedAlive,
  type RecordedChild,
} from "./supervisor-run.ts";
import {
  ensureUpHealth,
  ensureUpOff,
  supervisorHealth,
  supervisorRecord,
  type EnsureUpHealth,
  type SupervisorHealth,
} from "./supervisors.ts";
import { dedupeEnsureUp, dedupeLine, mergeEnsureUpDedupe, type DedupeEnsureUpOptions } from "./ensure-up-dedupe.ts";

export {
  dedupeEnsureUp,
  dedupeLine,
  mergeEnsureUpDedupe,
  type EnsureUpDedupe,
} from "./ensure-up-dedupe.ts";

/** Waits for the ensure-up loop to appear (the supervisor starts it), or returns its absent state at the deadline. */
export type WaitEnsureUpOptions = {
  readonly now?: () => number;
  readonly alive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

export async function waitEnsureUp(
  home: string,
  wanted: boolean,
  timeoutMs = 15_000,
  opts: WaitEnsureUpOptions = {},
): Promise<EnsureUpHealth> {
  const now = opts.now ?? Date.now;
  const alive = opts.alive ?? pidAlive;
  if (!wanted) return ensureUpHealth(home, now(), alive);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + timeoutMs;
  for (;;) {
    const health = ensureUpHealth(home, now(), alive);
    if (health.alive || now() >= deadline) return health;
    await sleep(250);
  }
}

/** What `dori up` shows after it made sure the supervised half of the stack runs. */
export type SupervisedState = {
  readonly health: readonly SupervisorHealth[];
  readonly ensureUp: EnsureUpHealth;
  readonly off: boolean;
};

/** A supervisor the OS still holds, even when its beat is late: a late beat is doubt, never permission for a second loop. */
export function supervisorProcessAlive(
  home: string,
  same: (child: RecordedChild) => boolean = strictRecordedAlive,
): boolean {
  const record = supervisorRecord(home, "supervisor");
  return record !== undefined && same({ pid: record.pid, at: record.startedAt });
}

export type SuperviseHomeOptions = {
  readonly startMissing: boolean;
  readonly spawn?: typeof spawnDetached;
  readonly wait?: typeof waitEnsureUp;
  readonly ensure?: typeof ensureSupervisors;
  readonly alive?: (pid: number) => boolean;
  readonly kill?: (pid: number) => boolean;
  readonly same?: (child: RecordedChild) => boolean;
  readonly started?: (pid: number) => number | null;
  /** Tests can supply the health snapshot that a fresh beat would produce. */
  readonly health?: readonly SupervisorHealth[];
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type WaitSupervisorUnitOptions = WaitEnsureUpOptions & {
  readonly same?: (child: RecordedChild) => boolean;
  readonly started?: (pid: number) => number | null;
};

/** True once the supervisor record names a live, start-time-matched unit. A stale or dead record does not count. */
export async function waitSupervisorUnit(
  home: string,
  name: string,
  timeoutMs: number,
  opts: WaitSupervisorUnitOptions = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const alive = opts.alive ?? pidAlive;
  const same =
    opts.same ??
    ((child: RecordedChild) =>
      recordedAlive(child, {
        alive,
        ...(opts.started === undefined ? {} : { started: opts.started }),
      }));
  const deadline = now() + timeoutMs;
  for (;;) {
    const unit = (supervisorRecord(home, "supervisor")?.units ?? []).find(
      (u) => u.name === name && alive(u.pid) && same({ pid: u.pid, at: u.startedAt ?? u.at }),
    );
    if (unit !== undefined) return true;
    if (now() >= deadline) return false;
    await sleep(250);
  }
}

/**
 * Starts the supervisors that are missing (`startMissing`) or only reads their health, then reports the ensure-up
 * plugin and waits briefly for its first beat. The cleanup runs before and after the supervisor start. The library
 * logger is silent by default; the CLI passes its console line so a harness never pollutes stdout.
 */
export async function superviseHome(home: string, opts: SuperviseHomeOptions): Promise<SupervisedState> {
  const alive = opts.alive ?? pidAlive;
  const spawned = opts.spawn ?? spawnDetached;
  const log = opts.log ?? (() => {});
  const off = ensureUpOff(home);
  const enabled = isPluginEnabled(home, "ensure-up");
  const wantUp = enabled && !off;
  const dedupeOpts: DedupeEnsureUpOptions = {
    alive,
    ...(opts.same === undefined ? {} : { same: opts.same }),
    keep: enabled,
    ...(opts.started === undefined ? {} : { started: opts.started }),
    ...(opts.kill === undefined ? {} : { kill: opts.kill }),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  };
  const first = await dedupeEnsureUp(home, dedupeOpts);
  const wait: WaitEnsureUpOptions = {
    alive,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
  };
  const health =
    opts.health ??
    (opts.startMissing
      ? await (opts.ensure ?? ensureSupervisors)(home, 30_000, {
          spawn: spawned,
          alive,
          ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
          ...(opts.now === undefined ? {} : { now: opts.now }),
        })
      : supervisorHealth(home, opts.now?.() ?? Date.now(), alive));
  // A record is authoritative: a dead recorded supervisor is not the owner even if its beat is fresh. Only a
  // home with no supervisor record may fall back to the heartbeat as its sole ownership evidence.
  const record = supervisorRecord(home, "supervisor");
  const supervised =
    record === undefined
      ? health.some((h) => h.name === "supervisor" && h.alive)
      : recordedAlive(
          { pid: record.pid, at: record.startedAt },
          { alive, ...(opts.started === undefined ? {} : { started: opts.started }) },
        );
  if (opts.startMissing && supervised && wantUp) {
    // The pane unit registers seconds after its process starts: keep the helper's 10 s unit default.
    await waitSupervisorUnit(home, "ensure-up", 10_000, {
      ...wait,
      ...(opts.same === undefined ? {} : { same: opts.same }),
      ...(opts.started === undefined ? {} : { started: opts.started }),
    });
  }
  const mergeSame =
    opts.same ??
    ((child: RecordedChild): boolean =>
      child.pid === process.pid ||
      strictRecordedAlive(child, { alive, ...(opts.started === undefined ? {} : { started: opts.started }) }));
  const dedupe = mergeEnsureUpDedupe(first, await dedupeEnsureUp(home, dedupeOpts), alive, mergeSame);
  const cleaned = dedupeLine(dedupe);
  if (cleaned !== undefined) log(cleaned);
  let ensureUp = await (opts.wait ?? waitEnsureUp)(home, wantUp, supervised ? 15_000 : 0, wait);
  // The dedupe already elected the keeper strictly; alive is the standby test here.
  const standby = dedupe.kept !== undefined && alive(dedupe.kept);
  // A live supervisor owns the plugin; a startMissing call starts supervisors, never a second ensure-up itself.
  if (!opts.startMissing && !supervised && wantUp && !ensureUp.alive && !standby) {
    spawned(pluginRunEntry(), home, ["ensure-up"]);
    ensureUp = await (opts.wait ?? waitEnsureUp)(home, true, 10_000, wait);
  }
  return { health, ensureUp, off };
}
