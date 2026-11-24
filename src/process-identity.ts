// Process identity shared by the receipt locks and the review queue: a pid alone is never evidence that it is still
// the process a record named. These helpers read the OS creation time, so a reused pid fails the identity check.

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export const HOSTNAME = hostname();

/** `kill(pid, 0)` is the liveness probe: ESRCH means dead; EPERM (or no error) means alive. */
export const pidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** OS process creation time in Unix ms, or null when it cannot be read (identity checks fail closed). */
export const readProcessStartTime = (pid: number): number | null => {
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

let ownStartTime: number | null | undefined;
/** The current process's start time never changes; a foreign pid is re-read every time so reuse cannot be cached. */
export const processStartTime = (pid: number): number | null => {
  if (pid !== process.pid) return readProcessStartTime(pid);
  if (ownStartTime === undefined) ownStartTime = readProcessStartTime(pid);
  return ownStartTime;
};
