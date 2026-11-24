import { execFileSync } from "node:child_process";
import { freemem, totalmem } from "node:os";
const sysctlMemoryLevel = (): string =>
  execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

/**
 * Free memory in whole megabytes. A percentage alone is misleading on a small machine: 10% of 7.7 GB was under a
 * gigabyte while four agents each hold a gigabyte private, so the loop also needs an absolute floor.
 */
export function memFreeMb(free: () => number = freemem): number {
  return Math.max(0, Math.round(free() / (1024 * 1024)));
}
