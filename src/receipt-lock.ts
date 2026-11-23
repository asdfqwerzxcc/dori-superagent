// The per-lane+tip receipt lock: an owner-first atomic acquire, a takeover only for a dead owner, and a release that
// only removes a lock the caller still owns.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";

export type ReceiptLockOwner = {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

export type ReceiptLock = { readonly token: string; readonly acquiredAt: number };

/** Test seams: pause before the fenced write, observe a contending writer, and shorten the wait budget. */
export type ReceiptWriteHooks = {
  readonly beforeWrite?: () => void | Promise<void>;
  readonly onLockWait?: () => void;
  readonly waitMs?: number;
};

/** A bare legacy lock directory older than this is taken over; a live owner is never preempted by age. */
export const RECEIPT_LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 10;

export const receiptLockPath = (root: string, key: string, tip: string): string =>
  join(root, "state", "reviews", `${key}@${tip}.receipt.lock`);

const ownerPath = (lock: string): string => join(lock, "owner.json");

const readOwner = (lock: string): ReceiptLockOwner | undefined => {
  try {
    const owner = readJson<ReceiptLockOwner>(ownerPath(lock));
    if (owner === undefined) return undefined;
    if (typeof owner.token !== "string" || typeof owner.acquiredAt !== "number") return undefined;
    return owner;
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

const contention = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const takeOver = (lock: string): void => {
  const tomb = `${lock}.stale.${randomUUID()}`;
  try {
    renameSync(lock, tomb);
    rmSync(tomb, { recursive: true, force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
};

const release = (lock: string, token: string): void => {
  const owner = readOwner(lock);
  if (owner?.token !== token) return;
  const tomb = `${lock}.released.${token}`;
  try {
    renameSync(lock, tomb);
    rmSync(tomb, { recursive: true, force: true });
  } catch {
    // A lock that cannot be renamed is left for the dead-owner takeover; the process is already done with it.
  }
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
  for (;;) {
    const token = randomUUID();
    const temp = `${lock}.new.${token}`;
    try {
      mkdirSync(temp);
      const owner: ReceiptLockOwner = { token, pid: process.pid, acquiredAt: Date.now() };
      try {
        writeJson(join(temp, "owner.json"), owner);
      } catch (e) {
        rmSync(temp, { recursive: true, force: true });
        throw e;
      }
      if (existsSync(lock)) {
        const error = new Error("lock exists") as NodeJS.ErrnoException;
        error.code = "EEXIST";
        throw error;
      }
      renameSync(temp, lock);
      try {
        return await fn({ token: owner.token, acquiredAt: owner.acquiredAt });
      } finally {
        release(lock, owner.token);
      }
    } catch (e) {
      rmSync(temp, { recursive: true, force: true });
      if (!contention(e)) throw e;
      hooks?.onLockWait?.();
      const owner = readOwner(lock);
      if (owner !== undefined) {
        if (pidAlive(owner.pid)) {
          if (Date.now() >= deadline)
            throw new Error(
              `receipt lock for ${key}@${tip} held by live pid ${owner.pid} since ${new Date(owner.acquiredAt).toISOString()} (waited ${waitMs} ms)`,
            );
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        // Re-check the token immediately before the rename, so a new owner that won the freed lock is never removed.
        if (readOwner(lock)?.token === owner.token) takeOver(lock);
        continue;
      }
      let mtime: number | undefined;
      try {
        mtime = statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (Date.now() - mtime > RECEIPT_LOCK_TTL_MS) {
        if (readOwner(lock) === undefined) takeOver(lock);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `receipt lock for ${key}@${tip} is a bare directory and did not become stale within ${waitMs} ms`,
        );
      await sleep(LOCK_RETRY_MS);
    }
  }
}
