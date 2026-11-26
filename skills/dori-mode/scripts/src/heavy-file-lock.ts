import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HeavyAdmissionError } from "./heavy-admission.ts";
import { type LockProbe, processStart } from "./heavy-start.ts";

export const LOCK_FILE = ".lock";
/** A lock whose owner record cannot be read is abandoned after this: the holder writes the record right after it
 * creates the file, so an unreadable one means that write never finished. The section a holder keeps is short (the
 * decide-and-claim step, whose host sample is capped near 3 s), never the job itself. */
export const LOCK_STALE_MS = 2 * 60_000;
/** A breaker holds for two filesystem calls; one this old was left by a process that died while breaking. */
const BREAK_STALE_MS = 10_000;
/** How long a probed start time stands for an unchanged record before it is probed again, so pid reuse is caught. */
const PROBE_TTL_MS = 2_000;
const LOCK_POLL_MS = 50;
/** Consecutive transient path answers (EPERM/EBUSY while another process replaces the lock) before admission refuses. */
const TRANSIENT_LIMIT = 200;

type LockRecord = { readonly pid: number; readonly start: string; readonly nonce: string };

const recordOf = (raw: string): LockRecord | null => {
  try {
    const v = JSON.parse(raw) as Partial<LockRecord> | null;
    return typeof v?.pid === "number" &&
      Number.isInteger(v.pid) &&
      v.pid > 0 &&
      typeof v.start === "string" &&
      Number.isFinite(Date.parse(v.start)) &&
      typeof v.nonce === "string" &&
      v.nonce !== ""
      ? { pid: v.pid, start: v.start, nonce: v.nonce }
      : null;
  } catch {
    return null;
  }
};

type Liveness = "alive" | "dead" | "unknown";

// Only a confirmed answer counts: ESRCH is dead, EPERM is alive, and every other error is unknown and refuses below.
const livenessOf = (pid: number): Liveness => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "alive" : "unknown";
  }
};

const refuse = (why: string): HeavyAdmissionError => new HeavyAdmissionError(why);

// Windows answers a handle taken while another process deletes or replaces the same file with EPERM/EBUSY. That is a
// race on the path, not evidence about the holder: the caller waits and looks again, and only a bounded run of those
// answers refuses.
const transient = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === "EPERM" || code === "EBUSY";
};

type SeenLock = { readonly raw: string; readonly record: LockRecord | null; readonly mtimeMs: number };

const seenLock = (lock: string): SeenLock | "gone" | "busy" => {
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(lock, "utf8");
    mtimeMs = statSync(lock).mtimeMs;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "ENOENT") return "gone";
    if (transient(e)) return "busy";
    throw refuse(`cannot read the heavy lock ${lock}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { raw, record: recordOf(raw), mtimeMs };
};

// A lock is abandoned only on evidence: its record is unreadable and old enough that the write never finished, its pid
// is confirmed dead, or the pid is alive with a different start time (a reused pid, so its original holder is gone). An
// answer that proves neither way refuses admission instead of taking a lock that may be held.
const abandoned = (
  seen: SeenLock,
  lock: string,
  startOf: (raw: string, pid: number) => string | undefined,
): boolean => {
  if (seen.record === null) return Date.now() - seen.mtimeMs > LOCK_STALE_MS;
  const { pid, start } = seen.record;
  const live = livenessOf(pid);
  if (live === "dead") return true;
  if (live === "unknown")
    throw refuse(
      `the heavy lock ${lock} names pid ${pid}, and this process cannot tell whether it is alive; refusing admission rather than taking a lock that may be held`,
    );
  const probed = startOf(seen.raw, pid);
  if (probed === undefined) {
    if (livenessOf(pid) === "dead") return true;
    throw refuse(
      `the heavy lock ${lock} names pid ${pid}, and its start time cannot be read to prove it is still that process; refusing admission rather than taking a lock that may be held`,
    );
  }
  return probed !== start;
};

/** How a lock left behind by a dead holder is taken: only the winner of the breaker file removes it, and only after it
 * re-reads the same bytes, so no takeover can remove a lock another process acquired after it looked. */
const breakLock = (lock: string, expectedRaw: string): "broke" | "retry" | "busy" => {
  const breaker = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, "wx");
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "EEXIST") {
      try {
        if (Date.now() - statSync(breaker).mtimeMs > BREAK_STALE_MS) rmSync(breaker, { force: true });
      } catch {
        return "busy";
      }
      return "retry";
    }
    if (transient(e)) return "busy";
    throw e;
  }
  try {
    let raw: string | undefined;
    try {
      raw = readFileSync(lock, "utf8");
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "ENOENT") return "broke";
      if (transient(e)) return "busy";
      throw e;
    }
    if (raw !== expectedRaw) return "broke";
    try {
      rmSync(lock, { force: true });
    } catch (e) {
      if (transient(e)) return "busy";
      throw e;
    }
    return "broke";
  } finally {
    closeSync(fd);
    try {
      rmSync(breaker, { force: true });
    } catch {
      // The breaker stays and BREAK_STALE_MS clears it: a later takeover waits at most that long.
    }
  }
};

const createLock = (lock: string): number | "held" | "busy" => {
  try {
    return openSync(lock, "wx");
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "EEXIST") return "held";
    if (transient(e)) return "busy";
    throw refuse(`cannot create the heavy lock ${lock}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const releaseLock = (lock: string, nonce: string): void => {
  try {
    if ((JSON.parse(readFileSync(lock, "utf8")) as Partial<LockRecord> | null)?.nonce === nonce)
      rmSync(lock, { force: true });
  } catch {
    return;
  }
};

/**
 * The same exclusion without flock(2): the lock is one file created with open(path, "wx"), so the atomic create is the
 * whole claim, and the owner record (pid and OS start time) is written through that same handle before the section
 * starts. A reader that finds the file without a readable record therefore never takes it for dead: it waits, or
 * abandons it only after LOCK_STALE_MS. The holder's start time lets a waiter tell a live holder from a pid that was
 * reused.
 */
export const underFileLock = async <T>(
  dir: string,
  section: () => T | Promise<T>,
  probe: LockProbe = processStart,
  attemptLimit: number = TRANSIENT_LIMIT,
): Promise<T> => {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, LOCK_FILE);
  const nonce = randomUUID();
  let busy = 0;
  let observed = "";
  let probedAt = 0;
  let probedStart: string | undefined;
  const startOf = (raw: string, pid: number): string | undefined => {
    if (raw !== observed || Date.now() - probedAt > PROBE_TTL_MS) {
      observed = raw;
      probedAt = Date.now();
      probedStart = probe(pid);
    }
    return probedStart;
  };
  for (;;) {
    const created = createLock(lock);
    if (typeof created === "number") {
      try {
        const own = probe(process.pid);
        if (own === undefined)
          throw refuse(
            `cannot read this process's start time, so the heavy lock ${lock} could not prove its holder; refusing admission rather than holding a lock no waiter can verify`,
          );
        writeSync(created, JSON.stringify({ pid: process.pid, start: own, nonce }));
      } catch (e) {
        closeSync(created);
        rmSync(lock, { force: true });
        throw e;
      }
      try {
        return await section();
      } finally {
        releaseLock(lock, nonce);
        closeSync(created);
      }
    }
    const seen = seenLock(lock);
    const broken = typeof seen === "object" && abandoned(seen, lock, startOf) ? breakLock(lock, seen.raw) : "retry";
    if (created === "busy" || seen === "busy" || broken === "busy") {
      busy++;
      if (busy >= attemptLimit)
        throw refuse(
          `the heavy lock ${lock} answered a transient path error (EPERM/EBUSY) ${attemptLimit} times over about ${((attemptLimit * LOCK_POLL_MS) / 1_000).toFixed(2)} s; refusing admission rather than waiting forever while another process keeps replacing that path`,
        );
    } else busy = 0;
    if (broken === "broke") continue;
    await Bun.sleep(LOCK_POLL_MS);
  }
};
