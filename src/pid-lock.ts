import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./process-liveness.ts";

type Held = { readonly pid?: unknown; readonly at?: unknown };

export function readPidLock(path: string): number | undefined {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as Held;
    return typeof held.pid === "number" && Number.isInteger(held.pid) ? held.pid : undefined;
  } catch {
    return undefined;
  }
}

export function releasePidLock(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // a lock we cannot remove is left to the age-free pid rule; never fail the caller over it
  }
}

/**
 * One holder per path, decided by a live recorded pid only (no process scan): an existing lock held by a live pid
 * refuses, and a lock whose holder is dead is taken over. The exit hook releases it so a clean stop leaves no lock.
 */
export function acquirePidLock(path: string, alive: (pid: number) => boolean = pidAlive): boolean {
  const write = (): boolean => {
    try {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      process.once("exit", () => releasePidLock(path));
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  const held = readPidLock(path);
  if (held !== undefined && held !== process.pid && alive(held)) return false;
  releasePidLock(path);
  return write();
}
