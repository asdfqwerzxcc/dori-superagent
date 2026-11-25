import { isPluginEnabled, readPluginRecord } from "./plugins/state.ts";
import { leaveContenders, readContenders, readPluginLock, START_SLACK_MS } from "./plugins/plugin.ts";
import { pidAlive, processStartTimeMs, terminateProcess } from "./process-liveness.ts";
import { recordedAlive, type RecordedChild } from "./supervisor-run.ts";
import { ensureUpRecord, supervisorRecord } from "./supervisors.ts";

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
};

type Candidate = RecordedChild & { readonly beat?: number };

/** Every pid a record, a contender or the live lock names, with the start time and the beat that proves it. */
function ensureUpCandidates(home: string, same: (child: RecordedChild) => boolean): Candidate[] {
  const unit = supervisorRecord(home, "supervisor")?.units.find((u) => u.name === "ensure-up");
  const loop = ensureUpRecord(home);
  const plugin = readPluginRecord(home, "ensure-up");
  const lock = readPluginLock(home, "ensure-up");
  return [
    ...(unit === undefined ? [] : [{ pid: unit.pid, at: unit.at, beat: unit.at }]),
    ...(loop === undefined ? [] : [{ pid: loop.pid, at: loop.startedAt, beat: loop.at }]),
    ...(plugin === undefined ? [] : [{ pid: plugin.pid, at: plugin.startedAt, beat: plugin.at }]),
    ...readContenders(home, "ensure-up", { same }).map((c) => ({ pid: c.pid, at: c.at, beat: c.at })),
    ...(lock?.startedAt === undefined ? [] : [{ pid: lock.pid, at: lock.startedAt, beat: lock.at }]),
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
  const same = deps.same ?? recordedAlive;
  const startedOf = deps.started ?? processStartTimeMs;
  const keep = deps.keep ?? isPluginEnabled(home, "ensure-up");
  const graceMs = deps.graceMs ?? 2_000;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = deps.now ?? Date.now;
  const unitPid = supervisorRecord(home, "supervisor")?.units.find((u) => u.name === "ensure-up")?.pid;
  const holderOf = (): number | undefined => {
    const lock = readPluginLock(home, "ensure-up");
    if (lock === undefined || lock.startedAt === undefined || lock.pid === process.pid) return undefined;
    if (!alive(lock.pid) || !same({ pid: lock.pid, at: lock.startedAt })) return undefined;
    return lock.pid;
  };
  const confirmed = (c: Candidate): boolean => {
    const started = startedOf(c.pid);
    return started !== null && Math.abs(started - c.at) <= START_SLACK_MS;
  };
  const startHolder = holderOf();
  const seen = new Set<number>();
  const live = ensureUpCandidates(home, same).filter((c) => {
    if (seen.has(c.pid) || c.pid === process.pid || !alive(c.pid) || !same(c)) return false;
    seen.add(c.pid);
    return true;
  });
  const liveHolder = startHolder === undefined ? undefined : live.find((c) => c.pid === startHolder)?.pid;
  const unit = live.find((c) => c.pid === unitPid);
  const freshest = live
    .filter((c) => c.pid !== unitPid)
    .reduce<Candidate | undefined>((best, c) => ((c.beat ?? 0) > (best?.beat ?? 0) ? c : best), undefined);
  const keptAtStart = keep ? (liveHolder ?? unit?.pid ?? freshest?.pid) : undefined;
  const spareUnit = keep ? unitPid : undefined;
  const killed: number[] = [];
  const failed: number[] = [];
  const unverified: number[] = [];
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
    keep &&
    finalLock !== undefined &&
    finalLock.startedAt !== undefined &&
    finalLock.pid !== process.pid &&
    alive(finalLock.pid) &&
    same({ pid: finalLock.pid, at: finalLock.startedAt })
      ? finalLock.pid
      : undefined;
  const keptSoFar = keep
    ? (finalHolder ?? (keptAtStart !== undefined && alive(keptAtStart) ? keptAtStart : undefined))
    : undefined;
  for (const c of live) await endCandidate(c, keptSoFar);
  const lastLock = keep ? readPluginLock(home, "ensure-up") : undefined;
  const lastHolder =
    keep &&
    lastLock !== undefined &&
    lastLock.startedAt !== undefined &&
    lastLock.pid !== process.pid &&
    alive(lastLock.pid) &&
    same({ pid: lastLock.pid, at: lastLock.startedAt })
      ? lastLock.pid
      : undefined;
  const kept = keep ? (lastHolder ?? keptSoFar) : undefined;
  const keptAt =
    kept === undefined
      ? undefined
      : (live.find((c) => c.pid === kept)?.at ?? (lastHolder === kept ? lastLock?.startedAt : undefined));
  const killedOut = killed.filter((pid) => pid !== kept);
  const failedOut = failed.filter((pid) => pid !== kept && alive(pid));
  const unverifiedOut = unverified.filter((pid) => pid !== kept && !killedOut.includes(pid));
  return {
    ...(kept === undefined ? {} : { kept }),
    ...(keptAt === undefined ? {} : { keptAt }),
    killed: killedOut,
    ...(failedOut.length === 0 ? {} : { failed: failedOut }),
    ...(unverifiedOut.length === 0 ? {} : { unverified: unverifiedOut }),
  };
}

export const mergeEnsureUpDedupe = (
  first: EnsureUpDedupe,
  second: EnsureUpDedupe,
  alive: (pid: number) => boolean = pidAlive,
  same: (child: RecordedChild) => boolean = () => true,
): EnsureUpDedupe => {
  const valid = (d: EnsureUpDedupe): boolean =>
    d.kept !== undefined && alive(d.kept) && (d.keptAt === undefined || same({ pid: d.kept, at: d.keptAt }));
  const secondKept = valid(second) ? second.kept : undefined;
  const carried = valid(first) ? first.kept : undefined;
  const kept = secondKept ?? carried;
  const keptAt = kept === undefined ? undefined : kept === secondKept ? second.keptAt : first.keptAt;
  const killed = [...new Set([...first.killed, ...second.killed])];
  const failed = [...new Set([...(first.failed ?? []), ...(second.failed ?? [])])].filter(
    (pid) => pid !== kept && !killed.includes(pid) && alive(pid),
  );
  const unverified = [...new Set([...(first.unverified ?? []), ...(second.unverified ?? [])])].filter(
    (pid) => pid !== kept && !killed.includes(pid),
  );
  return {
    ...(kept === undefined ? {} : { kept }),
    ...(keptAt === undefined ? {} : { keptAt }),
    killed,
    ...(failed.length === 0 ? {} : { failed }),
    ...(unverified.length === 0 ? {} : { unverified }),
  };
};

/** The one line a startup or a restart prints when it reduced several ensure-up processes to one. */
export const dedupeLine = (d: EnsureUpDedupe): string | undefined => {
  const failed = d.failed ?? [];
  const unverified = d.unverified ?? [];
  if (d.killed.length === 0 && failed.length === 0 && unverified.length === 0) return undefined;
  const parts = [`kept=${d.kept ?? "?"}`];
  if (d.killed.length > 0) parts.push(`killed=${d.killed.join(",")}`);
  if (failed.length > 0) parts.push(`failed=${failed.join(",")}`);
  if (unverified.length > 0) parts.push(`unverified=${unverified.join(",")}`);
  return `ENSURE_UP dedupe ${parts.join(" ")}`;
};
