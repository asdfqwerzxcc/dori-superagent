// The per-lane+tip receipt lock: an atomically created directory with an owner token, a stale TTL for takeover, and a
// release that only removes a lock the caller still owns.

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";

export type ReceiptLockOwner = {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
};

export type ReceiptLock = { readonly token: string; readonly acquiredAt: number };

/** Test seams: pause before the fenced read/write, and after the write while still holding the lock. */
export type ReceiptWriteHooks = {
  readonly beforeWrite?: () => void | Promise<void>;
  readonly beforeRelease?: () => void | Promise<void>;
  readonly onLockWait?: () => void;
};

/** A lock whose owner record is older than this is taken over; the critical section is a small read and write. */
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

const acquiredAtOf = (lock: string): number | undefined => readOwner(lock)?.acquiredAt;

const release = (lock: string, token: string): void => {
  const owner = readOwner(lock);
  if (owner?.token === token) rmSync(lock, { recursive: true, force: true });
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquires the lane+tip lock and runs `fn` with its epoch. A writer that finds an owner record older than the TTL
 * removes the directory and retries; a release only removes a directory whose owner.json still carries its token.
 */
export async function withReceiptLock<T>(
  root: string,
  key: string,
  tip: string,
  fn: (lock: ReceiptLock) => T | Promise<T>,
  hooks?: ReceiptWriteHooks,
): Promise<T> {
  const lock = receiptLockPath(root, key, tip);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let mine: ReceiptLockOwner | undefined;
    try {
      mkdirSync(lock);
      mine = { token: randomUUID(), pid: process.pid, acquiredAt: Date.now() };
      try {
        writeJson(ownerPath(lock), mine);
      } catch (e) {
        rmSync(lock, { recursive: true, force: true });
        throw e;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      hooks?.onLockWait?.();
      const acquiredAt = acquiredAtOf(lock);
      if (acquiredAt !== undefined && Date.now() - acquiredAt > RECEIPT_LOCK_TTL_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`receipt lock for ${key}@${tip} held longer than ${LOCK_WAIT_MS} ms`);
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    if (mine === undefined) throw new Error("receipt lock acquire failed");
    try {
      return await fn({ token: mine.token, acquiredAt: mine.acquiredAt });
    } finally {
      release(lock, mine.token);
    }
  }
}
