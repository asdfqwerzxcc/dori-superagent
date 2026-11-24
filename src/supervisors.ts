import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./process-liveness.ts";

// The record files and heartbeat files of the always-on processes. The supervisor writes state/supervisor.json and
// state/supervisor-heartbeat every 30 s; the watchdog writes its own pair. `dori status` reports what runs without
// asking the OS, and `dori restart` proves recovery by heartbeat age. Starting, killing and restarting them lives in
// supervisor-run.ts. The pre-merge records (gateway-supervisor.json, loops-supervisor.json) are neither read nor
// written any more.

export type SupervisorName = "supervisor" | "watchdog";
export const SUPERVISORS: readonly SupervisorName[] = ["supervisor", "watchdog"];

export type UnitRecord = { readonly name: string; readonly pid: number; readonly at: number; readonly pane?: string };
export type SupervisorRecord = {
  readonly name: SupervisorName;
  readonly pid: number;
  readonly startedAt: number;
  readonly units: readonly UnitRecord[];
  readonly at: number;
};
export type EnsureUpRecord = { readonly pid: number; readonly startedAt: number; readonly at: number };

export type UnitHealth = {
  readonly name: string;
  readonly pid?: number;
  readonly pane?: string;
  readonly alive: boolean;
};
export type SupervisorHealth = {
  readonly name: SupervisorName;
  readonly pid?: number;
  readonly alive: boolean;
  readonly heartbeatAgeMs?: number;
  readonly units: readonly UnitHealth[];
};
export type EnsureUpHealth = { readonly pid?: number; readonly alive: boolean; readonly heartbeatAgeMs?: number };

/** Three missed beats; the watchdog uses the same window for the supervisor heartbeat and the Discord socket. */
export const STALE_MS = 90_000;
export const WS_HEARTBEAT = "gateway-ws-heartbeat";
export const ENSURE_UP_HEARTBEAT = "ensure-up-heartbeat";
export const ENSURE_UP_RECORD = "ensure-up.json";
export const ENSURE_UP_OFF = "ensure-up.off";

const HEARTBEAT: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor-heartbeat",
  watchdog: "gateway-watchdog-heartbeat",
};
const RECORD: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor.json",
  watchdog: "watchdog-supervisor.json",
};
/** The installed home's shim first (that is what the Windows launchers and the watchdog spawn), else the repo entry. */
const SHIM: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor.ts",
  watchdog: "gateway-watchdog.ts",
};
const SOURCE: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor.ts",
  watchdog: "watchdog.ts",
};

export const stateDir = (home: string): string => join(home, "state");
export const heartbeatPath = (home: string, name: SupervisorName): string => join(stateDir(home), HEARTBEAT[name]);
export const recordPath = (home: string, name: SupervisorName): string => join(stateDir(home), RECORD[name]);

/** The entry to launch: the home's shim when installed there, else this checkout's own source. */
export function entryFor(home: string, name: SupervisorName): string {
  const shim = join(home, "bin", SHIM[name]);
  return existsSync(shim) ? shim : join(import.meta.dir, "supervisors", SOURCE[name]);
}

/** The children's recorded pids; a restart and a new supervisor take them back from `supervisor.json`. */ /** A heartbeat or record file's age in ms, or undefined when it is missing. */
export function ageMs(path: string, now: number = Date.now()): number | undefined {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** True when the file was written at or after `since` (one second of slack for coarse filesystem timestamps). */
export function freshSince(path: string, since: number): boolean {
  try {
    return statSync(path).mtimeMs >= since - 1000;
  } catch {
    return false;
  }
}

/** A pid the OS still holds: kernel32 OpenProcess on Windows (no console child), kill(pid, 0) on POSIX. */
export { pidAlive };

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // A supervisor that cannot write its record must keep supervising; status then shows the heartbeat alone.
  }
}

export function writeSupervisorRecord(home: string, record: SupervisorRecord): void {
  writeJson(recordPath(home, record.name), record);
}
export function writeEnsureUpRecord(home: string, record: EnsureUpRecord): void {
  writeJson(join(stateDir(home), ENSURE_UP_RECORD), record);
}
export const ensureUpOff = (home: string): boolean => existsSync(join(stateDir(home), ENSURE_UP_OFF));

/** One supervisor's record as written (pid, startedAt, units), or undefined when it never wrote one. */
export function supervisorRecord(home: string, name: SupervisorName): SupervisorRecord | undefined {
  return readJson<SupervisorRecord>(recordPath(home, name));
}

/** One supervisor's state: its recorded pid and heartbeat, liveness = pid alive and beat fresh. */
export function supervisorHealth(
  home: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): SupervisorHealth[] {
  return SUPERVISORS.map((name) => {
    const record = readJson<SupervisorRecord>(recordPath(home, name));
    const beat = ageMs(heartbeatPath(home, name), now);
    const fresh = beat !== undefined && beat <= STALE_MS;
    // A record from a supervisor that was killed under it is not evidence; its beat and its pid both have to agree.
    const live = record !== undefined ? alive(record.pid) && fresh : fresh;
    return {
      name,
      ...(record !== undefined ? { pid: record.pid } : {}),
      alive: live,
      ...(beat !== undefined ? { heartbeatAgeMs: beat } : {}),
      units: (record?.units ?? []).map((u) => ({
        name: u.name,
        pid: u.pid,
        ...(u.pane === undefined ? {} : { pane: u.pane }),
        alive: alive(u.pid),
      })),
    };
  });
}

/** The ensure-up loop's record, whether a supervisor or a person started it. */
export function ensureUpRecord(home: string): EnsureUpRecord | undefined {
  return readJson<EnsureUpRecord>(join(stateDir(home), ENSURE_UP_RECORD));
}

/** The ensure-up loop: its own record and beat, written whether a supervisor or a person started it. */
export function ensureUpHealth(
  home: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): EnsureUpHealth {
  const record = ensureUpRecord(home);
  const beat = ageMs(join(stateDir(home), ENSURE_UP_HEARTBEAT), now);
  const fresh = beat !== undefined && beat <= STALE_MS;
  return {
    ...(record !== undefined ? { pid: record.pid } : {}),
    alive: record !== undefined && alive(record.pid) && fresh,
    ...(beat !== undefined ? { heartbeatAgeMs: beat } : {}),
  };
}

const secs = (ms: number | undefined): string =>
  ms === undefined || !Number.isFinite(ms) ? "missing" : `${Math.max(0, Math.round(ms / 1000))}s`;

/** `SUPERVISED supervisor up pid=N hb=Ks units=a:1@pane,b:2(dead)` for `dori status` and `dori restart`. */
export function formatSupervisor(h: SupervisorHealth): string {
  const units = h.units
    .map((u) => `${u.name}:${u.pid ?? "?"}${u.pane === undefined ? "" : `@${u.pane}`}${u.alive ? "" : "(dead)"}`)
    .join(",");
  return `SUPERVISED ${h.name.padEnd(10)} ${h.alive ? "up" : "DOWN"} pid=${h.pid ?? "?"} hb=${secs(h.heartbeatAgeMs)}${units ? ` units=${units}` : ""}`;
}
export function formatWatchdog(h: SupervisorHealth): string {
  return `WATCHDOG ${h.alive ? "up" : "DOWN"} pid=${h.pid ?? "?"} hb=${secs(h.heartbeatAgeMs)}`;
}
/** The supervisor line first, then the watchdog: one `SUPERVISED` line is the contract `dori status` keeps. */
export function formatSupervised(health: readonly SupervisorHealth[]): string[] {
  return health.map((h) => (h.name === "watchdog" ? formatWatchdog(h) : formatSupervisor(h)));
}
export function formatEnsureUp(h: EnsureUpHealth, off: boolean): string {
  if (off) return `ENSURE-UP off (${ENSURE_UP_OFF})`;
  return `ENSURE-UP ${h.alive ? "up" : "DOWN"} pid=${h.pid ?? "?"} hb=${secs(h.heartbeatAgeMs)}`;
}

const beatState = (age: number | undefined): string =>
  age === undefined ? "missing" : `stale ${Math.max(0, Math.round(age / 1000))}s`;

/**
 * What `dori restart` left missing, each piece named with its reason: the supervisor beat, the ws beat, the supervisor
 * itself, a unit, or the ensure-up beat. Empty when the restart settled.
 */
export function restartMissing(opts: {
  readonly home: string;
  readonly since: number;
  readonly expected: readonly string[];
  readonly wanted: boolean;
  readonly health: readonly SupervisorHealth[];
  readonly ensureUp: EnsureUpHealth;
  readonly now: number;
}): string[] {
  const sup = heartbeatPath(opts.home, "supervisor");
  const ws = join(stateDir(opts.home), WS_HEARTBEAT);
  const missing: string[] = [];
  if (!freshSince(sup, opts.since)) missing.push(`supervisor heartbeat ${beatState(ageMs(sup, opts.now))}`);
  if (!freshSince(ws, opts.since)) missing.push(`gateway-ws heartbeat ${beatState(ageMs(ws, opts.now))}`);
  const supervisor = opts.health.find((h) => h.name === "supervisor");
  if (supervisor?.alive !== true)
    missing.push(`supervisor ${supervisor === undefined ? "not running" : `pid=${supervisor.pid ?? "?"} down`}`);
  for (const name of opts.expected) {
    const unit = supervisor?.units.find((u) => u.name === name);
    if (unit === undefined) missing.push(`unit ${name} missing`);
    else if (!unit.alive) missing.push(`unit ${name} pid=${unit.pid ?? "?"} dead`);
  }
  if (opts.wanted && !opts.ensureUp.alive) {
    missing.push(`ensure-up heartbeat ${beatState(opts.ensureUp.heartbeatAgeMs)}`);
  }
  return missing;
}
