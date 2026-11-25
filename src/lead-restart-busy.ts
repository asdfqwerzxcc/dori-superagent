// One marker for the kill -> shell -> relaunch window: ensure-up and `dori up` must not raise a second lead while a
// swap is between its kill and its typed relaunch. A marker left by a killed worker stops blocking after five minutes.

import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEAD_RESTART_BUSY = "lead-restart.busy";
export const LEAD_RESTART_BUSY_MS = 5 * 60_000;

const pathOf = (home: string): string => join(home, "state", LEAD_RESTART_BUSY);

/** True while a fresh restart marker exists; a stale marker is removed and ignored. */
export function leadRestartBusy(home: string, now: number = Date.now()): boolean {
  try {
    if (now - statSync(pathOf(home)).mtimeMs > LEAD_RESTART_BUSY_MS) {
      rmSync(pathOf(home), { force: true });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function markLeadRestartBusy(home: string, pane: string): void {
  try {
    mkdirSync(dirname(pathOf(home)), { recursive: true });
    writeFileSync(pathOf(home), JSON.stringify({ pane, pid: process.pid, at: Date.now() }));
  } catch {
    // A marker that cannot be written must not stop the restart itself.
  }
}

export function clearLeadRestartBusy(home: string): void {
  try {
    rmSync(pathOf(home), { force: true });
  } catch {
    // A stale marker is ignored by leadRestartBusy after five minutes.
  }
}
