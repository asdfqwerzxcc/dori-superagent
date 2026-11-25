import { isPluginEnabled } from "./plugins/state.ts";
import { pluginRunEntry } from "./plugins/plugin.ts";
import { pidAlive } from "./process-liveness.ts";
import { ensureSupervisors, recordedAlive, spawnDetached, type RecordedChild } from "./supervisor-run.ts";
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
export function supervisorProcessAlive(home: string, same: (child: RecordedChild) => boolean = recordedAlive): boolean {
  const record = supervisorRecord(home, "supervisor");
  return record !== undefined && same({ pid: record.pid, at: record.startedAt });
}

export type SuperviseHomeOptions = {
  readonly startMissing: boolean;
  readonly spawn?: typeof spawnDetached;
  readonly alive?: (pid: number) => boolean;
  readonly kill?: (pid: number) => boolean;
  readonly same?: (child: RecordedChild) => boolean;
  readonly started?: (pid: number) => number | null;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type WaitSupervisorUnitOptions = WaitEnsureUpOptions & {
  readonly same?: (child: RecordedChild) => boolean;
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
  const same = opts.same ?? recordedAlive;
  const deadline = now() + timeoutMs;
  for (;;) {
    const unit = (supervisorRecord(home, "supervisor")?.units ?? []).find(
      (u) => u.name === name && alive(u.pid) && same({ pid: u.pid, at: u.at }),
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
  const same = opts.same ?? recordedAlive;
  const off = ensureUpOff(home);
  const enabled = isPluginEnabled(home, "ensure-up");
  const wantUp = enabled && !off;
  const dedupeOpts: DedupeEnsureUpOptions = {
    alive,
    same,
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
  const health = opts.startMissing
    ? await ensureSupervisors(home, 30_000, {
        spawn: spawned,
        alive,
        ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
        ...(opts.now === undefined ? {} : { now: opts.now }),
      })
    : supervisorHealth(home, opts.now?.() ?? Date.now(), alive);
  const supervised = supervisorProcessAlive(home, same) || health.some((h) => h.name === "supervisor" && h.alive);
  if (opts.startMissing && supervised && wantUp) {
    await waitSupervisorUnit(home, "ensure-up", 10_000, { ...wait, same });
  }
  const dedupe = mergeEnsureUpDedupe(first, await dedupeEnsureUp(home, dedupeOpts), alive, same);
  const cleaned = dedupeLine(dedupe);
  if (cleaned !== undefined) log(cleaned);
  let ensureUp = await waitEnsureUp(home, wantUp, supervised ? 15_000 : 0, wait);
  const standby =
    dedupe.kept !== undefined &&
    (dedupe.keptAt === undefined ? alive(dedupe.kept) : same({ pid: dedupe.kept, at: dedupe.keptAt }));
  // The supervisor owns the plugin; only a home nobody supervises starts one here, and only with no live keeper.
  if (!opts.startMissing && !supervised && wantUp && !ensureUp.alive && !standby) {
    spawned(pluginRunEntry(), home, ["ensure-up"]);
    ensureUp = await waitEnsureUp(home, true, 10_000, wait);
  }
  return { health, ensureUp, off };
}
