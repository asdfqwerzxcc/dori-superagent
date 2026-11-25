import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, processStartTimeMs } from "../process-liveness.ts";

/** The OS start time is stable for a pid; a different value means the pid was reused. */
export const START_SLACK_MS = 2_000;

/** A null-start owner is doubt only while its record is fresh; past this, a stale external lock is recoverable. */
export const NULL_START_GRACE_MS = 30_000;

export type LockRecordDeps = {
  readonly alive?: (pid: number) => boolean;
  readonly started?: (pid: number) => number | null;
  readonly now?: () => number;
};

export type LockOwnerRecord = {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly at: number;
  readonly startedAt: number | null;
};

/** The protocol's state lives in a directory; the historical path stays a file older releases can still read. */
export const lockDir = (lock: string): string => `${lock}.d`;

export const lockOwnerPath = (lock: string): string => join(lockDir(lock), "owner.json");

export const readJsonFile = (path: string): Record<string, unknown> | undefined => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A token identifies one owner record; a record without one falls back to its immutable fields. */
export const tokenOf = (record: Record<string, unknown> | undefined): string => {
  if (record === undefined) return "ownerless";
  const token = record["token"];
  if (typeof token === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(token)) return token;
  const raw = `${Number(record["pid"])}-${Number(record["at"])}-${record["startedAt"] ?? "null"}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
};

export const sameOwner = (a: Record<string, unknown> | undefined, b: LockOwnerRecord): boolean =>
  a !== undefined && tokenOf(a) === b.token && Number(a["pid"]) === b.pid;

/**
 * A live pid owns a record; a version 1 record additionally needs its OS start time to match, so a reused pid is
 * stale. An unreadable start is doubt (held); a null or corrupt recorded start is doubt only while fresh, which is
 * how a stale external lock recovers. No version means the old file format: a live holder is never broken.
 */
export function lockHeldByRecord(raw: unknown, deps: LockRecordDeps = {}): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const record = raw as { version?: unknown; pid?: unknown; at?: unknown; startedAt?: unknown };
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!(deps.alive ?? pidAlive)(pid)) return false;
  if (Number(record.version) !== 1) return true;
  const rawStart = record.startedAt;
  const startedAt = rawStart === null || rawStart === undefined ? null : Number(rawStart);
  if (startedAt === null || !Number.isInteger(startedAt) || startedAt <= 0) {
    const at = Number(record.at);
    const now = (deps.now ?? Date.now)();
    return Number.isInteger(at) && at > 0 && now - at <= NULL_START_GRACE_MS;
  }
  const started = (deps.started ?? processStartTimeMs)(pid);
  if (started === null) return true;
  return Math.abs(started - startedAt) <= START_SLACK_MS;
}

/** The owner in the lock directory, a live temp claimant (doubt, never absent), then the historical path. */
export function readLockRecord(lock: string): Record<string, unknown> | undefined {
  const owner = readJsonFile(lockOwnerPath(lock));
  if (owner !== undefined) return owner;
  try {
    if (statSync(lockDir(lock)).isDirectory()) {
      for (const name of readdirSync(lockDir(lock))) {
        const m = /^\.owner\.(\d+)\./.exec(name);
        if (m === null) continue;
        const pid = Number(m[1]);
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return { version: 0, pid, at: 0 };
      }
    }
  } catch {}
  try {
    // An earlier layout put the directory at the historical path; its record still names its owner.
    if (statSync(lock).isDirectory()) return readJsonFile(join(lock, "owner.json"));
  } catch {}
  return readJsonFile(lock);
}
