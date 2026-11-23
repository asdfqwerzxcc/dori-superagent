// The per-lane+tip receipt lock: an owner-first atomic acquire, process-identity liveness (pid + OS start time), a
// takeover only for a verified dead owner, and a release that only removes a lock the caller still owns.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";

export type ReceiptLockOwner = {
  readonly token: string;
  readonly pid: number;
  /** OS process creation time in Unix ms; null when it could not be read (liveness fails closed). */
  readonly startTime: number | null;
  readonly host: string;
  readonly acquiredAt: number;
};
export type ReceiptLock = { readonly token: string; readonly acquiredAt: number };
/** Test seams: pause before the fenced write, observe a writer, race a takeover, shorten the wait. */
export type ReceiptWriteHooks = {
  readonly beforeWrite?: () => void | Promise<void>;
  readonly onLockWait?: () => void;
  readonly beforeTakeOverRename?: () => void | Promise<void>;
  readonly waitMs?: number;
};

/** A bare legacy lock directory older than this is taken over; a live owner is never preempted by age. */
export const RECEIPT_LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 10;
const HOSTNAME = hostname();
let ownStartTime: number | null | undefined;
export const receiptLockPath = (root: string, key: string, tip: string): string =>
  join(root, "state", "reviews", `${key}@${tip}.receipt.lock`);
const ownerPath = (lock: string): string => join(lock, "owner.json");
const readProcessStartTime = (pid: number): number | null => {
  try {
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }`;
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const value = Number(out);
      return out !== "" && Number.isFinite(value) && value > 0 ? value : null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const value = Date.parse(out);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
};
// The current process's start time never changes; a foreign pid is re-read every time so reuse cannot be cached.
const processStartTime = (pid: number): number | null => {
  if (pid !== process.pid) return readProcessStartTime(pid);
  if (ownStartTime === undefined) ownStartTime = readProcessStartTime(pid);
  return ownStartTime;
};
const readOwner = (lock: string): ReceiptLockOwner | undefined => {
  try {
    const owner = readJson<Partial<ReceiptLockOwner>>(ownerPath(lock));
    if (owner === undefined || typeof owner.token !== "string" || typeof owner.acquiredAt !== "number")
      return undefined;
    if (!Number.isFinite(owner.acquiredAt)) return undefined;
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
    if (owner.startTime != null && (typeof owner.startTime !== "number" || !Number.isFinite(owner.startTime)))
      return undefined;
    if (owner.host !== undefined && typeof owner.host !== "string") return undefined;
    const { token, pid, startTime, host, acquiredAt } = owner;
    return { token, pid, startTime: startTime ?? null, host: host ?? HOSTNAME, acquiredAt };
  } catch {
    return undefined;
  }
};
/** `kill(pid, 0)` is the liveness probe: ESRCH means dead; EPERM (or no error) means alive. */
const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
type Liveness = { readonly alive: boolean; readonly why?: string };
// A live pid with a different start time is a reused pid, so the recorded owner is dead.
const ownerLiveness = (owner: ReceiptLockOwner): Liveness => {
  if (owner.host !== HOSTNAME) return { alive: true, why: `owner host ${owner.host} is not this host` };
  if (!pidAlive(owner.pid)) return { alive: false };
  if (owner.startTime === null) return { alive: true, why: "owner start time is unreadable" };
  const startTime = processStartTime(owner.pid);
  if (startTime === null) return { alive: true, why: `process start time for pid ${owner.pid} is unreadable` };
  return startTime === owner.startTime ? { alive: true } : { alive: false };
};
const heldError = (key: string, tip: string, owner: ReceiptLockOwner, why: string | undefined, waitMs: number) => {
  const live = why === undefined;
  const held = `receipt lock for ${key}@${tip} held by ${live ? "live pid" : "pid"} ${owner.pid} since ${new Date(owner.acquiredAt).toISOString()}`;
  return new Error(
    live
      ? `${held} (waited ${waitMs} ms)`
      : `${held}; owner liveness cannot be verified (${why}); treated as live (waited ${waitMs} ms)`,
  );
};
const contention = (e: unknown, lock: string): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  // Windows reports a rename onto an existing directory as EPERM; a rename EPERM with no lock is a real error.
  return code === "EEXIST" || code === "ENOTEMPTY" || (code === "EPERM" && existsSync(lock));
};
// Renames the lock to a tombstone and restores it when the token moved: a live owner is never lost to a tombstone.
const takeOver = (lock: string, expectedToken: string | undefined): void => {
  const tomb = `${lock}.tombstone.${randomUUID()}`;
  try {
    renameSync(lock, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const moved = readOwner(tomb);
  if (moved?.token !== expectedToken) {
    try {
      renameSync(tomb, lock);
    } catch (e) {
      throw new Error(
        `receipt lock takeover moved token ${moved?.token ?? "missing"} and could not restore it: ${String(e)}`,
      );
    }
    return;
  }
  rmSync(tomb, { recursive: true, force: true });
};
const release = (lock: string, token: string): void => {
  const owner = readOwner(lock);
  if (owner === undefined) {
    if (existsSync(lock)) throw new Error(`receipt lock ${lock} has no owner; refusing release by ${token}`);
    return;
  }
  if (owner.token !== token)
    throw new Error(`receipt lock ${lock} lost ownership to ${owner.token}; refusing release by ${token}`);
  const tomb = `${lock}.released.${token}`;
  try {
    renameSync(lock, tomb);
  } catch (e) {
    const now = readOwner(lock);
    if (now === undefined) {
      if (!existsSync(lock)) return;
      throw new Error(`receipt lock ${lock} has no owner after a failed release by ${token}`);
    }
    if (now.token !== token)
      throw new Error(`receipt lock ${lock} lost ownership to ${now.token}; refusing release by ${token}`);
    throw e;
  }
  rmSync(tomb, { recursive: true, force: true });
};

/**
 * Creates `lock.new.<token>` with owner.json first, then renames it to the lock directory. Rename fails when the
 * target exists, so a lock directory can never exist without its owner record (except a legacy/corrupt bare dir).
 * A live owner is waited for and then reported; a dead owner is taken over immediately; a bare directory is taken
 * over only after the TTL.
 */
export async function withReceiptLock<T>(
  root: string,
  key: string,
  tip: string,
  fn: (lock: ReceiptLock) => T | Promise<T>,
  hooks?: ReceiptWriteHooks,
): Promise<T> {
  const lock = receiptLockPath(root, key, tip);
  const waitMs = hooks?.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  const waitOrTakeOver = async (): Promise<void> => {
    hooks?.onLockWait?.();
    const owner = readOwner(lock);
    if (owner !== undefined) {
      const liveness = ownerLiveness(owner);
      if (liveness.alive) {
        if (Date.now() >= deadline) throw heldError(key, tip, owner, liveness.why, waitMs);
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        return;
      }
      if (readOwner(lock)?.token === owner.token) {
        await hooks?.beforeTakeOverRename?.();
        takeOver(lock, owner.token);
      }
      return;
    }
    let mtime: number;
    try {
      mtime = statSync(lock).mtimeMs;
    } catch {
      return;
    }
    if (Date.now() - mtime > RECEIPT_LOCK_TTL_MS) {
      if (readOwner(lock) === undefined) {
        await hooks?.beforeTakeOverRename?.();
        takeOver(lock, undefined);
      }
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `receipt lock for ${key}@${tip} is a bare directory and did not become stale within ${waitMs} ms`,
      );
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  };
  for (;;) {
    const token = randomUUID();
    const acquiredAt = Date.now();
    const temp = `${lock}.new.${token}`;
    try {
      mkdirSync(temp);
      const startTime = processStartTime(process.pid);
      const owner: ReceiptLockOwner = { token, pid: process.pid, startTime, host: HOSTNAME, acquiredAt };
      writeJson(join(temp, "owner.json"), owner);
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      throw e;
    }
    let contended = existsSync(lock);
    if (!contended) {
      try {
        renameSync(temp, lock);
      } catch (e) {
        if (!contention(e, lock)) {
          rmSync(temp, { recursive: true, force: true });
          throw e;
        }
        contended = true;
      }
    }
    if (contended) {
      rmSync(temp, { recursive: true, force: true });
      await waitOrTakeOver();
      continue;
    }
    try {
      return await fn({ token, acquiredAt });
    } finally {
      release(lock, token);
    }
  }
}
