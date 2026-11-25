// One marker for the kill -> shell -> relaunch window: ensure-up and `dori up` must not raise a second lead while a
// swap is between its kill and its typed relaunch. The marker carries its own deadline (the swap's durations plus a
// margin) and an owner token, so a dry-run or a late worker cannot clear another owner's marker.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEAD_RESTART_BUSY = "lead-restart.busy";
export const LEAD_RESTART_BUSY_MS = 5 * 60_000;
export const LEAD_RESTART_MARGIN_MS = 60_000;

export type LeadRestartBusyRecord = {
  readonly pane: string;
  readonly pid: number;
  readonly token: string;
  readonly at: number;
  readonly until: number;
};

const pathOf = (home: string): string => join(home, "state", LEAD_RESTART_BUSY);

/** The swap's own maximum plus margin: drain, death wait and launch wait. */
export function leadRestartTtl(drainMs: number, deathMs = 30_000, launchMs = 120_000): number {
  return Math.max(0, drainMs) + deathMs + launchMs + LEAD_RESTART_MARGIN_MS;
}

function readRecord(home: string): LeadRestartBusyRecord | undefined {
  try {
    return JSON.parse(readFileSync(pathOf(home), "utf8")) as LeadRestartBusyRecord;
  } catch {
    return undefined;
  }
}

/** True while a fresh restart marker exists; an expired marker (its own deadline or the legacy five minutes) is removed. */
export function leadRestartBusy(home: string, now: number = Date.now()): boolean {
  const record = readRecord(home);
  let until: number;
  try {
    until =
      record !== undefined && Number.isFinite(record.until)
        ? record.until
        : statSync(pathOf(home)).mtimeMs + LEAD_RESTART_BUSY_MS;
  } catch {
    return false;
  }
  if (now > until) {
    try {
      rmSync(pathOf(home), { force: true });
    } catch {
      // A stale marker is ignored even if the file cannot be removed now.
    }
    return false;
  }
  return true;
}

export function markLeadRestartBusy(
  home: string,
  pane: string,
  ttlMs: number = LEAD_RESTART_BUSY_MS,
): string | undefined {
  const token = randomUUID();
  const at = Date.now();
  try {
    mkdirSync(dirname(pathOf(home)), { recursive: true });
    writeFileSync(pathOf(home), JSON.stringify({ pane, pid: process.pid, token, at, until: at + Math.max(0, ttlMs) }));
    return token;
  } catch {
    return undefined;
  }
}

/** Removes the marker only when the caller still owns it; a newer owner's marker is left untouched. */
export function clearLeadRestartBusy(home: string, token: string | undefined): void {
  if (token === undefined) return;
  const record = readRecord(home);
  if (record?.token !== token) return;
  try {
    rmSync(pathOf(home), { force: true });
  } catch {
    // The marker expires by its own deadline; a failed removal must not stop the restart.
  }
}
