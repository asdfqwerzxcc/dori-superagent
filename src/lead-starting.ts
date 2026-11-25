// A new lead pane reports `shell` until its agent registers. This marker gives a start grace after `dori up` opens a
// lead, and caps repeated attempts inside one window, so ensure-up cannot open a new lead on every tick.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LEAD_STARTING = "lead-starting.json";
export const LEAD_STARTING_MS = 180_000;
export const LEAD_START_MAX_ATTEMPTS = 3;
export const LEAD_START_WINDOW_MS = 15 * 60_000;

type LeadStartingRecord = { readonly attempts: number; readonly at: number };

const pathOf = (home: string): string => join(home, "state", LEAD_STARTING);

function readRecord(home: string): LeadStartingRecord | undefined {
  try {
    return JSON.parse(readFileSync(pathOf(home), "utf8")) as LeadStartingRecord;
  } catch {
    return undefined;
  }
}

export function leadStarting(home: string, now: number = Date.now()): { starting: boolean; attempts: number } {
  const record = readRecord(home);
  if (record === undefined) return { starting: false, attempts: 0 };
  if (now - record.at > LEAD_START_WINDOW_MS) {
    try {
      rmSync(pathOf(home), { force: true });
    } catch {
      // An old marker is ignored even if the file cannot be removed now.
    }
    return { starting: false, attempts: 0 };
  }
  const attempts = Number.isInteger(record.attempts) ? record.attempts : 0;
  return { starting: now - record.at <= LEAD_STARTING_MS || attempts >= LEAD_START_MAX_ATTEMPTS, attempts };
}

export function markLeadStarting(home: string, now: number = Date.now()): number {
  const record = readRecord(home);
  const attempts = record !== undefined && now - record.at <= LEAD_START_WINDOW_MS ? record.attempts + 1 : 1;
  try {
    mkdirSync(dirname(pathOf(home)), { recursive: true });
    writeFileSync(pathOf(home), JSON.stringify({ attempts, at: now }));
  } catch {
    // A marker that cannot be written must not stop the lead creation itself.
  }
  return attempts;
}

export function clearLeadStarting(home: string): void {
  try {
    rmSync(pathOf(home), { force: true });
  } catch {
    // The marker expires by its own window; a failed removal must not stop the next lead attempt.
  }
}
