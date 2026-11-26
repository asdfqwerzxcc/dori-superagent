import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { HeavyAdmissionError } from "./heavy-admission.ts";
import { LOCK_FILE, underFileLock } from "./heavy-file-lock.ts";
import { type LockProbe, processStart } from "./heavy-start.ts";

export { HeavyAdmissionError } from "./heavy-admission.ts";
export { LOCK_STALE_MS, underFileLock } from "./heavy-file-lock.ts";
export { type LockProbe, processStart } from "./heavy-start.ts";

const LOCK_POLL_MS = 50;
// Same values in glibc <sys/file.h> and xnu <sys/fcntl.h>.
const LOCK_EX = 2,
  LOCK_NB = 4,
  LOCK_UN = 8;
const LIBC: Readonly<Record<string, string>> = { linux: "libc.so.6", darwin: "/usr/lib/libSystem.B.dylib" };

export type Flock = (fd: number, operation: number) => number;

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
 * The section guard this platform has. win32 has no flock(2), so it gets a lock file instead of an error: `dori heavy`
 * keeps running there under static slots. Undefined means "use the lock file".
 */
export const platformLock = (platform: string = process.platform): Flock | undefined => {
  if (platform === "win32") return undefined;
  systemFlock ??= loadFlock(platform);
  return systemFlock;
};

// Sampling the host, counting, deciding and claiming (a takeover included) run under one lock on <dir>/.lock, so no
// two waiters decide on the same count, take the same orphaned slot, or decide on memory sampled before a long wait for
// the lock. flock(2) is the kernel's: it drops the lock only when its holder exits, so a paused holder keeps it and a
// dead one never leaves it behind. Without flock(2) the lock file gives the same exclusion by owner pid.
export const underLock = async <T>(
  dir: string,
  section: () => T | Promise<T>,
  load: () => Flock | undefined = () => platformLock(),
  probe: LockProbe = processStart,
): Promise<T> => {
  const flock = load();
  if (flock === undefined) return await underFileLock(dir, section, probe);
  const fd = openSync(join(dir, LOCK_FILE), "a");
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
