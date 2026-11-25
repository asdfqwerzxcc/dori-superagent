import { existsSync, linkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  lockHeldByRecord,
  readJsonFile,
  sameOwner,
  tokenOf,
  type LockOwnerRecord,
  type LockRecordDeps,
} from "./lock-record.ts";

/** Creates the historical-path file only if it is still absent; the content is complete before the name appears. */
const writeMirror = (path: string, record: LockOwnerRecord): "ok" | "exists" | "error" => {
  const tmp = `${path}.${process.pid}.${record.token}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(record));
    linkSync(tmp, path);
    return "ok";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    // Filesystems without hard links still get an exclusive create; the record is one small write.
    try {
      writeFileSync(path, JSON.stringify(record), { flag: "wx" });
      return "ok";
    } catch (fallback) {
      return (fallback as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "error";
    }
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
};

/**
 * Mirrors the owner into the historical file older releases read. A live old-format holder there is doubt: the caller
 * releases the directory it just took and waits, so a rolling upgrade never breaks the old child's lock.
 */
export const claimMirror = (lock: string, record: LockOwnerRecord, deps: LockRecordDeps): boolean => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let exists = false;
    try {
      if (statSync(lock).isDirectory()) return false;
      exists = true;
    } catch {}
    const current = exists ? readJsonFile(lock) : undefined;
    if (exists) {
      if (current !== undefined && lockHeldByRecord(current, deps)) return sameOwner(current, record);
      // A dead holder and an unreadable/truncated file are both removable: the old release rewrote after a parse
      // error too, so a damaged historical file can never block every claim.
      try {
        rmSync(lock, { force: true });
      } catch {
        return false;
      }
    }
    const wrote = writeMirror(lock, record);
    if (wrote === "ok") return true;
    if (wrote === "error") return false;
  }
  return false;
};

/** Drops the historical file only when it still names this process (and, when given, this owner token). */
export const releaseMirrorIfOwner = (lock: string, token?: string): void => {
  const mirror = readJsonFile(lock);
  if (mirror === undefined || Number(mirror["version"]) !== 1 || Number(mirror["pid"]) !== process.pid) return;
  if (token !== undefined && mirror["token"] !== token) return;
  try {
    rmSync(lock, { force: true });
  } catch {}
};

/**
 * Removes a directory an earlier layout left at the historical path once its owner is stale; a live owner or a fresh
 * claim in progress is held. Reports whether the path held a legacy directory at all.
 */
export const migrateLegacyDir = (lock: string, deps: LockRecordDeps): "absent" | "held" | "migrated" => {
  let isDir = false;
  let age: number | null = null;
  try {
    const stat = statSync(lock);
    isDir = stat.isDirectory();
    age = Date.now() - stat.mtimeMs;
  } catch {}
  if (!isDir) return "absent";
  const record = readJsonFile(join(lock, "owner.json"));
  if (record === undefined ? age !== null && age < 30_000 : lockHeldByRecord(record, deps)) return "held";
  const moved = `${lock}.legacy.${process.pid}.${Date.now()}`;
  try {
    renameSync(lock, moved);
  } catch {
    return "held";
  }
  const after = readJsonFile(join(moved, "owner.json"));
  if (record === undefined ? after !== undefined : tokenOf(after) !== tokenOf(record)) {
    try {
      if (!existsSync(lock)) renameSync(moved, lock);
    } catch {}
    return "held";
  }
  try {
    rmSync(moved, { recursive: true, force: true });
  } catch {}
  return "migrated";
};
