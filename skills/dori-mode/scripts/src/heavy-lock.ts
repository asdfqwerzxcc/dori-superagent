import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_POLL_MS = 50;
/** A lock directory this old was left behind by a holder that exited without removing it (a killed process). */
export const LOCK_STALE_MS = 2 * 60_000;
// Same values in glibc <sys/file.h> and xnu <sys/fcntl.h>.
const LOCK_EX = 2,
  LOCK_NB = 4,
  LOCK_UN = 8;
const LIBC: Readonly<Record<string, string>> = { linux: "libc.so.6", darwin: "/usr/lib/libSystem.B.dylib" };

export type Flock = (fd: number, operation: number) => number;

export class HeavyAdmissionError extends Error {}

// No lock means no heavy admission: a platform or libc without flock(2) stops `dori heavy` with this error instead of
// admitting jobs unguarded.
export const loadFlock = (platform: string = process.platform, path = LIBC[platform]): Flock => {
  if (path === undefined)
    throw new HeavyAdmissionError(`dori heavy needs flock(2); it supports linux (glibc) and macOS, not ${platform}`);
  try {
    const lib = dlopen(path, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    return (fd, operation) => lib.symbols.flock(fd, operation);
  } catch (e) {
    throw new HeavyAdmissionError(
      `dori heavy needs flock(2) from ${path} on ${platform} and could not load it: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

let systemFlock: Flock | undefined;

/**
 * The section guard this platform has. win32 has no flock(2), so it gets a lock directory instead of an error: `dori
 * heavy` keeps running there under static slots. Undefined means "use the directory lock".
 */
export const platformLock = (platform: string = process.platform): Flock | undefined => {
  if (platform === "win32") return undefined;
  systemFlock ??= loadFlock(platform);
  return systemFlock;
};

const ownerPid = (lock: string): number => {
  try {
    return Number(readFileSync(join(lock, "owner"), "utf8").trim());
  } catch {
    return Number.NaN;
  }
};

const holderAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string } | null)?.code === "EPERM";
  }
};

// A lock whose owner is confirmed dead is taken over at once; one without an owner file only once it is LOCK_STALE_MS
// old, so a holder between mkdir and its owner write is never entered twice.
const staleLock = (lock: string): boolean => {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lock).mtimeMs;
  } catch {
    return false;
  }
  const pid = ownerPid(lock);
  return Number.isInteger(pid) && pid > 0 ? !holderAlive(pid) : Date.now() - mtimeMs > LOCK_STALE_MS;
};

/**
 * The same exclusion without flock(2): mkdir is atomic on every platform, the owner file names the holder, and a dead
 * holder's lock is taken over instead of waited on.
 */
export const underDirLock = async <T>(dir: string, section: () => T | Promise<T>): Promise<T> => {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock.dir");
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner"), String(process.pid));
      break;
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== "EEXIST") throw e;
    }
    if (staleLock(lock)) rmSync(lock, { recursive: true, force: true });
    else await Bun.sleep(LOCK_POLL_MS);
  }
  try {
    return await section();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
};

// Sampling the host, counting, deciding and claiming (a takeover included) run under one lock on <dir>/.lock, so no
// two waiters decide on the same count, take the same orphaned slot, or decide on memory sampled before a long wait for
// the lock. flock(2) is the kernel's: it drops the lock only when its holder exits, so a paused holder keeps it and a
// dead one never leaves it behind. Without flock(2) the directory lock above gives the same exclusion by owner pid.
export const underLock = async <T>(
  dir: string,
  section: () => T | Promise<T>,
  load: () => Flock | undefined = () => platformLock(),
): Promise<T> => {
  const flock = load();
  if (flock === undefined) return await underDirLock(dir, section);
  const fd = openSync(join(dir, ".lock"), "a");
  try {
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) await Bun.sleep(LOCK_POLL_MS);
    try {
      return await section();
    } finally {
      flock(fd, LOCK_UN);
    }
  } finally {
    closeSync(fd);
  }
};
