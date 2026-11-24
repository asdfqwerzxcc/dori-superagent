import { execFileSync } from "node:child_process";
import { win32Kernel } from "./win32-kernel.ts";

// A recorded pid is evidence only while the OS still holds it. Windows answers that with kernel32 OpenProcess (no
// console application is spawned for a status read); POSIX keeps kill(pid, 0), whose EPERM still means alive.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_TERMINATE = 0x0001;
const ERROR_ACCESS_DENIED = 5;
const STILL_ACTIVE = 259;
const FILETIME_UNIX_MS = 11_644_473_600_000;

const nodeAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether the OS still holds this pid. A handle we may not open (EPERM/ACCESS_DENIED) is alive, not dead. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kernel = win32Kernel();
  if (kernel === undefined) return nodeAlive(pid);
  const handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (handle === null || handle === 0) return kernel.GetLastError() === ERROR_ACCESS_DENIED;
  const exitCode = new Uint32Array(1);
  const read = kernel.GetExitCodeProcess(handle, exitCode);
  kernel.CloseHandle(handle);
  return read !== 0 && exitCode[0] === STILL_ACTIVE;
}

/** Ends one process without taskkill: OpenProcess(PROCESS_TERMINATE) + TerminateProcess, or SIGTERM on POSIX. */
export function terminateProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const kernel = win32Kernel();
  if (kernel === undefined) {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
  const handle = kernel.OpenProcess(PROCESS_TERMINATE, 0, pid);
  if (handle === null || handle === 0) return false;
  const killed = kernel.TerminateProcess(handle, 1) !== 0;
  kernel.CloseHandle(handle);
  return killed;
}

/** The OS creation time in Unix ms, or null when it cannot be read (identity checks then fail closed). */
export function processStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const kernel = win32Kernel();
  if (kernel !== undefined) {
    const handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (handle === null || handle === 0) return null;
    const created = new BigUint64Array(1);
    const exited = new BigUint64Array(1);
    const kernelTime = new BigUint64Array(1);
    const userTime = new BigUint64Array(1);
    const ok = kernel.GetProcessTimes(handle, created, exited, kernelTime, userTime);
    kernel.CloseHandle(handle);
    if (ok === 0) return null;
    const createdTime = created[0];
    if (createdTime === undefined) return null;
    const ms = Number(createdTime / 10_000n) - FILETIME_UNIX_MS;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const value = Date.parse(out);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** True when the pid started within `slackMs` of the recorded time, so a reused pid is not mistaken for the record. */
export function startedNear(pid: number, at: number, slackMs = 10_000): boolean {
  const started = processStartTimeMs(pid);
  return started !== null && Math.abs(started - at) <= slackMs;
}
