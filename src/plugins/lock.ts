import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive, processStartTimeMs } from "../process-liveness.ts";
import { START_SLACK_MS } from "./plugin.ts";

export type LockRecordDeps = {
  readonly alive?: (pid: number) => boolean;
  readonly started?: (pid: number) => number | null;
};

const ownerPath = (lock: string): string => join(lock, "owner.json");

/** A token identifies one owner record; a record without one falls back to its immutable fields. */
const tokenOf = (record: Record<string, unknown> | undefined): string => {
  if (record === undefined) return "ownerless";
  const token = record["token"];
  if (typeof token === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(token)) return token;
  const raw = `${Number(record["pid"])}-${Number(record["at"])}-${record["startedAt"] ?? "null"}`;
  return raw.replace(/[^A-Za-z0-9_-]/g, "_");
};

const takeoverPath = (lock: string, generation: string): string => `${lock}.takeover.${generation}`;

/** One taker per stale generation. A dead taker's token is recoverable after a short grace. */
const acquireTakeover = (lock: string, generation: string, deps: LockRecordDeps): boolean => {
  const path = takeoverPath(lock, generation);
  const create = (): boolean => {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, startedAt: (deps.started ?? processStartTimeMs)(process.pid) ?? null }),
        );
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };
  if (create()) return true;
  try {
    const raw = readJson(path);
    const pid = Number(raw?.["pid"]);
    const age = Date.now() - statSync(path).mtimeMs;
    const invalid = !Number.isInteger(pid) || pid <= 0;
    const rawStart = raw?.["startedAt"];
    const recorded = rawStart === null || rawStart === undefined ? null : Number(rawStart);
    const started = recorded === null ? null : (deps.started ?? processStartTimeMs)(pid);
    const startOk = recorded === null || started === null || Math.abs(started - recorded) <= START_SLACK_MS;
    // An empty token is a create-then-write in progress; only an older one is abandoned.
    const dead = invalid
      ? age > 2_000
      : !(deps.alive ?? pidAlive)(pid) || !startOk || (age > 5_000 && started === null);
    if (dead) {
      rmSync(path, { force: true });
      return create();
    }
  } catch {}
  return false;
};

const releaseTakeover = (lock: string, generation: string): void => {
  try {
    rmSync(takeoverPath(lock, generation), { force: true });
  } catch {}
};

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The lock is a directory now; an older file at the same path is still read for migration. */
const readLockRecord = (lock: string): Record<string, unknown> | undefined =>
  readJson(ownerPath(lock)) ?? readJson(ownerPath(lock)) ?? readJson(lock);

/**
 * A version 1 lock is held only by the process that wrote it: its start time is compared with the live pid. A
 * non-null mismatch is a reused pid (stale); an unreadable start time or a null recorded one is doubt, so it stays held.
 * An unversioned old-format lock is unverifiable and is taken over once on upgrade.
 */
export function lockHeldByRecord(raw: unknown, deps: LockRecordDeps = {}): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const record = raw as { version?: unknown; pid?: unknown; startedAt?: unknown };
  const version = Number(record.version);
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!(deps.alive ?? pidAlive)(pid)) return false;
  if (version !== 1) return true; // an old-format live holder is doubt; wait for it to exit
  const rawStart = record.startedAt;
  if (rawStart === null || rawStart === undefined) return true;
  const startedAt = Number(rawStart);
  if (!Number.isInteger(startedAt) || startedAt <= 0) return true;
  const started = (deps.started ?? processStartTimeMs)(pid);
  if (started === null) return true;
  return Math.abs(started - startedAt) <= START_SLACK_MS;
}

const selfHeld = (lock: string, deps: LockRecordDeps = {}): boolean => {
  const record = readJson(ownerPath(lock));
  if (record === undefined) return false;
  if (Number(record["version"]) !== 1 || Number(record["pid"]) !== process.pid) return false;
  const rawStart = record["startedAt"];
  if (rawStart === null || rawStart === undefined) return true;
  const startedAt = Number(rawStart);
  if (!Number.isInteger(startedAt) || startedAt <= 0) return true;
  const own = (deps.started ?? processStartTimeMs)(process.pid);
  return own === null || Math.abs(own - startedAt) <= START_SLACK_MS;
};

const dirAgeMs = (lock: string): number | null => {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null;
  }
};

export function acquirePluginLock(lock: string, deps: LockRecordDeps = {}): boolean {
  mkdirSync(dirname(lock), { recursive: true });
  const claim = (): boolean => {
    try {
      mkdirSync(lock);
    } catch {
      return false;
    }
    const token = randomBytes(8).toString("hex");
    const tmp = join(lock, `.owner.${process.pid}.${token}.tmp`);
    try {
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          token,
          pid: process.pid,
          at: Date.now(),
          startedAt: (deps.started ?? processStartTimeMs)(process.pid) ?? null,
        }),
      );
      renameSync(tmp, ownerPath(lock));
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {}
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {}
      return false;
    }
    return selfHeld(lock, deps);
  };
  if (claim()) return true;
  const record = readLockRecord(lock);
  if (record !== undefined) {
    if (lockHeldByRecord(record, deps)) return false;
  } else {
    // An ownerless directory is a claim in progress; only an old one is abandoned.
    const age = dirAgeMs(lock);
    if (age !== null && age < 30_000) return false;
  }
  // One taker per stale generation; the token is the compare-and-swap guard. The lock is re-read inside it,
  // so a loser that was delayed after judging the old record never renames a fresh owner's lock.
  const generation = tokenOf(record);
  if (!acquireTakeover(lock, generation, deps)) return false;
  try {
    const current = readLockRecord(lock);
    if (tokenOf(current) !== generation) return false;
    const stale = `${lock}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(lock, stale);
    } catch {
      return false;
    }
    const moved = readLockRecord(stale);
    if (record === undefined ? moved !== undefined : tokenOf(moved) !== generation) {
      // The directory changed under us; put a legitimate fresh owner back and never claim over it.
      try {
        if (!existsSync(lock)) renameSync(stale, lock);
      } catch {}
      return false;
    }
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {}
    return claim();
  } finally {
    releaseTakeover(lock, generation);
  }
}

/** Removes the lock only while it still names this process; a takeover's lock is left alone. */
export function releaseLockIfOwner(lock: string): void {
  const record = readJson(ownerPath(lock)) ?? readJson(lock);
  if (record === undefined || Number(record["pid"]) !== process.pid) return;
  try {
    rmSync(ownerPath(lock), { force: true });
    rmSync(lock, { recursive: true, force: true });
  } catch {}
}
