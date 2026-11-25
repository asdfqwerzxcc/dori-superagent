import { isPluginEnabled, readPluginRecord } from "./plugins/state.ts";
import {
  leaveContenders,
  pluginLockHeld,
  pluginRunEntry,
  readContenders,
  readPluginLock,
  START_SLACK_MS,
} from "./plugins/plugin.ts";
import { pidAlive, processStartTimeMs, terminateProcess } from "./process-liveness.ts";
import { scanEnsureUpProcesses } from "./ensure-up-scan.ts";
import type { RecordedChild } from "./supervisor-run.ts";
import { ensureUpRecord, supervisorRecord, type SupervisorRecord, type UnitRecord } from "./supervisors.ts";

export type EnsureUpDedupe = {
  readonly kept?: number;
  readonly keptAt?: number;
  readonly killed: readonly number[];
  readonly failed?: readonly number[];
  readonly unverified?: readonly number[];
};
export type DedupeEnsureUpOptions = {
  readonly alive?: (pid: number) => boolean;
  readonly kill?: (pid: number) => boolean;
  readonly same?: (child: RecordedChild) => boolean;
  readonly started?: (pid: number) => number | null;
  /** False when the plugin is disabled: no ensure-up process is left at all. */
  readonly keep?: boolean;
  readonly graceMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** One supervisor snapshot for this pass; tests use it to model a unit replaced between reads. */
  readonly supervisor?: () => SupervisorRecord | undefined;
  /** A process scan for a pid no record names; the default bounds `ps` by this entry and DORI_HOME. */
  readonly scan?: () => readonly number[] | Promise<readonly number[]>;
};

type Candidate = RecordedChild & {
  readonly beat?: number;
  readonly source?: "unit" | "loop" | "plugin" | "contender" | "lock" | "scan";
};

/** Every pid a record, a contender or the live lock names, with the start time and the beat that proves it. */
function ensureUpCandidates(
  home: string,
  same: (child: RecordedChild) => boolean,
  unit: UnitRecord | undefined,
  plugin: { readonly pid: number; readonly startedAt: number; readonly at: number } | undefined,
  started: ((pid: number) => number | null) | undefined,
): Candidate[] {
  const loop = ensureUpRecord(home);
  const lock = readPluginLock(home, "ensure-up");
  const valid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) > 0;
  return [
    ...(unit !== undefined && valid(unit.pid)
      ? [{ pid: unit.pid, at: unit.startedAt ?? unit.at, beat: unit.at, source: "unit" as const }]
      : []),
    ...(loop !== undefined && valid(loop.pid)
      ? [{ pid: loop.pid, at: loop.startedAt, beat: loop.at, source: "loop" as const }]
      : []),
    ...(plugin !== undefined && valid(plugin.pid)
      ? [{ pid: plugin.pid, at: plugin.startedAt, beat: plugin.at, source: "plugin" as const }]
      : []),
    ...readContenders(home, "ensure-up", {
      same,
      ...(started === undefined ? {} : { started }),
    }).map((c) => ({
      pid: c.pid,
      at: c.at,
      beat: c.beat ?? c.at,
      source: "contender" as const,
    })),
    ...(lock !== undefined && valid(lock.pid)
      ? [{ pid: lock.pid, at: lock.startedAt ?? 0, beat: lock.at, source: "lock" as const }]
      : []),
  ];
}

/**
 * One ensure-up loop per home: the live lock holder, else the supervisor's unit, else the non-unit loop that beat last.
 * The lock is re-read before every kill, the initial keeper is revisited once the final keeper is known, a standby is
 * spared, a pid counts as killed only after the OS confirms it is gone, and an unreadable start time is never killed.
 */
export async function dedupeEnsureUp(home: string, deps: DedupeEnsureUpOptions = {}): Promise<EnsureUpDedupe> {
  const alive = deps.alive ?? pidAlive;
  const kill = deps.kill ?? terminateProcess;
  const startedOf = deps.started ?? processStartTimeMs;
  const supervisor = (deps.supervisor ?? (() => supervisorRecord(home, "supervisor")))();
  const unitRecord = supervisor?.units.find((u) => u.name === "ensure-up");
  const pluginRecord = readPluginRecord(home, "ensure-up");
  const scan =
    deps.scan ?? (async () => (await scanEnsureUpProcesses({ home, entry: pluginRunEntry() })).map((p) => p.pid));
  const scanned = (await scan())
    .filter((pid) => pid !== process.pid && pid !== process.ppid && alive(pid))
    .map((pid) => ({ pid, at: startedOf(pid) ?? 0, beat: 0, source: "scan" as const }));
  const same =
    deps.same ??
    ((c: RecordedChild): boolean => {
      if (c.pid === process.pid) return false;
      const started = startedOf(c.pid);
      if (started === null) return false;
      return Math.abs(started - c.at) <= START_SLACK_MS;
    });
  const keep = deps.keep ?? isPluginEnabled(home, "ensure-up");
  const graceMs = deps.graceMs ?? 2_000;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const lockDeps = {
    alive,
    ...(deps.started === undefined ? {} : { started: deps.started }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  const holderOf = (): number | undefined => {
    const lock = readPluginLock(home, "ensure-up");
    if (lock === undefined || lock.pid === process.pid || !alive(lock.pid)) return undefined;
    return lockHeld(lock) ? lock.pid : undefined;
  };
  const lockHeld = (lock: { readonly pid: number; readonly startedAt: number | null }): boolean =>
    lock.startedAt === null ? pluginLockHeld(home, "ensure-up", lockDeps) : same({ pid: lock.pid, at: lock.startedAt });
  const startHolder = holderOf();
  const seen = new Set<number>();
  const live: Candidate[] = [];
  const unsure = new Set<number>();
  for (const c of [...ensureUpCandidates(home, same, unitRecord, pluginRecord, deps.started), ...scanned]) {
    if (c.pid === process.pid || !alive(c.pid)) continue;
    if (same(c)) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      live.push(c);
    } else if (!seen.has(c.pid)) {
      unsure.add(c.pid);
    }
  }
  const liveHolder = startHolder === undefined ? undefined : live.find((c) => c.pid === startHolder)?.pid;
  // The unit is protective only when its record is live and start-time matched; otherwise the supervisor's
  // current plugin record is the real replacement, and a raw stale pid must not shield a reused loop.
  const unit = live.find((c) => c.source === "unit") ?? live.find((c) => c.source === "plugin");
  const freshest = live
    .filter((c) => c.pid !== unit?.pid)
    .reduce<Candidate | undefined>((best, c) => ((c.beat ?? 0) > (best?.beat ?? 0) ? c : best), undefined);
  const keptAtStart = keep ? (liveHolder ?? unit?.pid ?? freshest?.pid) : undefined;
  const spareUnit = keep ? unit?.pid : undefined;
  const confirmed = (c: Candidate): boolean => {
    const started = startedOf(c.pid);
    return started !== null && Math.abs(started - c.at) <= START_SLACK_MS;
  };
  const killed: number[] = [];
  const failed: number[] = [];
  const unverified: number[] = [...unsure].filter((pid) => !live.some((c) => c.pid === pid));
  const confirmGone = async (pid: number): Promise<boolean> => {
    const deadline = now() + graceMs;
    while (alive(pid) && now() < deadline) await sleep(50);
    return !alive(pid);
  };
  const endCandidate = async (c: Candidate, protectedPid: number | undefined): Promise<void> => {
    if (c.pid === protectedPid || c.pid === spareUnit) return;
    if (killed.includes(c.pid) || failed.includes(c.pid) || unverified.includes(c.pid)) return;
    if (!alive(c.pid) || !same(c)) return;
    if (keep && holderOf() === c.pid) return;
    if (!confirmed(c)) {
      unverified.push(c.pid);
      return;
    }
    // A target that claimed the lock after the holder check is a fresh holder, not a duplicate.
    const fresh = readPluginLock(home, "ensure-up");
    if (
      keep &&
      fresh !== undefined &&
      fresh.pid === c.pid &&
      (fresh.startedAt === null || same({ pid: fresh.pid, at: fresh.startedAt })) &&
      now() - fresh.at <= 2_000
    ) {
      return;
    }
    kill(c.pid);
    if (await confirmGone(c.pid)) {
      killed.push(c.pid);
      leaveContenders(home, "ensure-up", c.pid);
    } else {
      failed.push(c.pid);
    }
  };
  for (const c of live) await endCandidate(c, keptAtStart);
  const finalLock = keep ? readPluginLock(home, "ensure-up") : undefined;
  const finalHolder =
    keep && finalLock !== undefined && finalLock.pid !== process.pid && alive(finalLock.pid) && lockHeld(finalLock)
      ? finalLock.pid
      : undefined;
  const keptSoFar = keep
    ? (finalHolder ?? (keptAtStart !== undefined && alive(keptAtStart) ? keptAtStart : undefined))
    : undefined;
  for (const c of live) await endCandidate(c, keptSoFar);
  const lastLock = keep ? readPluginLock(home, "ensure-up") : undefined;
  const lastHolder =
    keep && lastLock !== undefined && lastLock.pid !== process.pid && alive(lastLock.pid) && lockHeld(lastLock)
      ? lastLock.pid
      : undefined;
  const finalFallback = keptSoFar !== undefined && alive(keptSoFar) ? keptSoFar : undefined;
  const kept = keep ? (lastHolder ?? finalFallback) : undefined;
  const keptAt =
    kept === undefined
      ? undefined
      : (live.find((c) => c.pid === kept)?.at ??
        (lastHolder === kept ? (lastLock?.startedAt ?? undefined) : undefined));
  const killedOut = killed.filter((pid) => pid !== kept);
  const failedOut = failed.filter((pid) => pid !== kept && alive(pid));
  const unverifiedOut = unverified.filter(
    (pid) => pid !== kept && !killedOut.includes(pid) && !failedOut.includes(pid) && alive(pid),
  );
  return {
    ...(kept === undefined ? {} : { kept }),
    ...(keptAt === undefined ? {} : { keptAt }),
    killed: killedOut,
    ...(failedOut.length === 0 ? {} : { failed: failedOut }),
    ...(unverifiedOut.length === 0 ? {} : { unverified: unverifiedOut }),
  };
}

export { dedupeLine, mergeEnsureUpDedupe } from "./ensure-up-dedupe-line.ts";
