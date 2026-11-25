import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive, processStartTimeMs } from "../process-liveness.ts";
import {
  lockDepsWithBeat,
  lockDir,
  lockHeldByRecord,
  lockOwnerPath,
  NULL_START_GRACE_MS,
  readJsonFile,
  START_SLACK_MS,
  tokenOf,
  type LockOwnerRecord,
  type LockRecordDeps,
} from "./lock-record.ts";
import { claimMirror, migrateLegacyDir, releaseMirrorIfOwner } from "./lock-mirror.ts";

export type { LockRecordDeps } from "./lock-record.ts";
export { lockHeldByRecord } from "./lock-record.ts";

const takeoverPath = (lock: string, generation: string): string => `${lockDir(lock)}.takeover.${generation}`;

const ownerRecord = (deps: LockRecordDeps): LockOwnerRecord => ({
  version: 1,
  token: randomBytes(8).toString("hex"),
  pid: process.pid,
  at: (deps.now ?? Date.now)(),
  startedAt: (deps.started ?? processStartTimeMs)(process.pid) ?? null,
});

const writeOwner = (lock: string, record: LockOwnerRecord): boolean => {
  const tmp = join(lockDir(lock), `.owner.${process.pid}.${record.token}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, lockOwnerPath(lock));
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    return false;
  }
};

/** Our own record, read without the injected process table: a test's fake pids must not declare us dead. */
const selfHeld = (lock: string, token: string, deps: LockRecordDeps): boolean => {
  const record = readJsonFile(lockOwnerPath(lock));
  if (record === undefined || Number(record["version"]) !== 1 || Number(record["pid"]) !== process.pid) return false;
  if (typeof record["token"] === "string" && record["token"] !== token) return false;
  const rawStart = record["startedAt"];
  const startedAt = rawStart === null || rawStart === undefined ? null : Number(rawStart);
  if (startedAt === null || !Number.isInteger(startedAt) || startedAt <= 0) {
    const at = Number(record["at"]);
    return Number.isInteger(at) && (deps.now ?? Date.now)() - at <= NULL_START_GRACE_MS;
  }
  const own = (deps.started ?? processStartTimeMs)(process.pid);
  return own === null || Math.abs(own - startedAt) <= START_SLACK_MS;
};

const dropOwnedDir = (lock: string, token: string): void => {
  const record = readJsonFile(lockOwnerPath(lock));
  if (record !== undefined && Number(record["pid"]) !== process.pid) return;
  if (record !== undefined && typeof record["token"] === "string" && record["token"] !== token) return;
  try {
    rmSync(lockDir(lock), { recursive: true, force: true });
  } catch {}
};

const claimDir = (lock: string, deps: LockRecordDeps): boolean => {
  try {
    mkdirSync(lockDir(lock));
  } catch {
    return false;
  }
  const record = ownerRecord(deps);
  if (!writeOwner(lock, record) || !claimMirror(lock, record, deps)) {
    dropOwnedDir(lock, record.token);
    return false;
  }
  if (!selfHeld(lock, record.token, deps)) {
    dropOwnedDir(lock, record.token);
    releaseMirrorIfOwner(lock, record.token);
    return false;
  }
  return true;
};

/** One taker per stale generation. A dead taker's token is recoverable after a short grace. */
const acquireTakeover = (lock: string, generation: string, deps: LockRecordDeps): boolean => {
  const path = takeoverPath(lock, generation);
  const create = (): boolean => {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            startedAt: (deps.started ?? processStartTimeMs)(process.pid) ?? null,
          }),
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
    const raw = readJsonFile(path);
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

const dirAgeMs = (lock: string): number | null => {
  try {
    return Date.now() - statSync(lockDir(lock)).mtimeMs;
  } catch {
    return null;
  }
};

/** The directory's own owner record only; the historical mirror never decides a directory takeover. */
const readDirOwner = (lock: string): Record<string, unknown> | undefined => readJsonFile(lockOwnerPath(lock));

/**
 * One child per plugin per home. The directory is the compare-and-swap generation guard; the historical file is the
 * mirror older releases read, so both protocols see exactly one live owner.
 */
export function acquirePluginLock(lock: string, deps: LockRecordDeps = {}): boolean {
  const judged = lockDepsWithBeat(lock, deps);
  mkdirSync(dirname(lock), { recursive: true });
  if (migrateLegacyDir(lock, judged) === "held") return false;
  const mirror = readJsonFile(lock);
  if (mirror !== undefined && lockHeldByRecord(mirror, judged)) return false;
  if (claimDir(lock, judged)) return true;
  if (!existsSync(lockDir(lock))) return false;
  const record = readDirOwner(lock);
  if (record !== undefined) {
    if (lockHeldByRecord(record, judged)) return false;
  } else {
    // An ownerless directory is a claim in progress; only an old one is abandoned. The historical mirror is a
    // separate file and never supplies this generation.
    const age = dirAgeMs(lock);
    if (age !== null && age < 30_000) return false;
  }
  // The token is the compare-and-swap guard; re-reading inside it means a delayed loser never renames a fresh owner.
  const generation = tokenOf(record);
  if (!acquireTakeover(lock, generation, judged)) return false;
  try {
    const current = readDirOwner(lock);
    if (tokenOf(current) !== generation) return false;
    const stale = `${lockDir(lock)}.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(lockDir(lock), stale);
    } catch {
      return false;
    }
    const moved = readJsonFile(join(stale, "owner.json"));
    if (record === undefined ? moved !== undefined : tokenOf(moved) !== generation) {
      try {
        if (!existsSync(lockDir(lock))) renameSync(stale, lockDir(lock));
      } catch {}
      return false;
    }
    try {
      rmSync(stale, { recursive: true, force: true });
    } catch {}
    return claimDir(lock, judged);
  } finally {
    releaseTakeover(lock, generation);
  }
}

/** Removes the lock only while it still names this process; a takeover's lock is left alone. */
export function releaseLockIfOwner(lock: string): void {
  const owner = readJsonFile(lockOwnerPath(lock));
  if (owner === undefined || Number(owner["version"]) !== 1 || Number(owner["pid"]) !== process.pid) {
    releaseMirrorIfOwner(lock);
    return;
  }
  const token = typeof owner["token"] === "string" ? owner["token"] : undefined;
  const moved = `${lockDir(lock)}.release.${process.pid}.${Date.now()}`;
  try {
    renameSync(lockDir(lock), moved);
  } catch {
    return;
  }
  const held = readJsonFile(join(moved, "owner.json"));
  if (Number(held?.["pid"]) !== process.pid || (token !== undefined && held?.["token"] !== token)) {
    try {
      if (!existsSync(lockDir(lock))) renameSync(moved, lockDir(lock));
    } catch {}
    return;
  }
  try {
    rmSync(moved, { recursive: true, force: true });
  } catch {}
  releaseMirrorIfOwner(lock, token);
}
