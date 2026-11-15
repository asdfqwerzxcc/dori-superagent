import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { spawnExec, type Exec } from "./runtime/exec.ts";
import {
  ageMs,
  ensureUpEntry,
  ensureUpHealth,
  ensureUpOff,
  entryFor,
  heartbeatPath,
  pidAlive,
  stateDir,
  SUPERVISORS,
  supervisorHealth,
  WS_HEARTBEAT,
  type EnsureUpHealth,
  type SupervisorHealth,
  type SupervisorName,
} from "./supervisors.ts";

/** A process the OS reports, with the command line `dori restart` matches against. */
export type Proc = { readonly pid: number; readonly command: string };

const SHIM: Readonly<Record<SupervisorName, string>> = {
  gateway: "gateway-supervisor.ts",
  loops: "loops-supervisor.ts",
  watchdog: "gateway-watchdog.ts",
};
const SOURCE: Readonly<Record<SupervisorName, string>> = {
  gateway: "gateway.ts",
  loops: "loops.ts",
  watchdog: "watchdog.ts",
};

/** What a process list is searched for: the installed shim or the repo entry that a dev checkout runs directly. */
const entryPatterns = (name: SupervisorName): readonly string[] => [SHIM[name], `supervisors/${SOURCE[name]}`];
export const matchPids = (procs: readonly Proc[], ...patterns: readonly string[]): number[] =>
  procs.filter((p) => patterns.some((s) => p.command.includes(s))).map((p) => p.pid);

const WINDOWS_LIST =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";

/** `ConvertTo-Json` output: one object when the OS found one bun, an array otherwise. */
export function parseCim(text: string): Proc[] {
  try {
    const parsed = JSON.parse(text.trim() || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      const r = (row ?? {}) as { ProcessId?: unknown; CommandLine?: unknown };
      const pid = Number(r.ProcessId);
      return Number.isInteger(pid) && pid > 0 ? [{ pid, command: String(r.CommandLine ?? "") }] : [];
    });
  } catch {
    return [];
  }
}

/** `ps -A -o pid=,args=`: the pid, then the whole command line. */
export function parsePs(text: string): Proc[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), command: m[2] ?? "" }] : [];
  });
}

/** Every bun process with its command line; no list rather than a wrong one when the OS query fails. */
export async function listProcesses(exec: Exec = spawnExec): Promise<Proc[]> {
  const windows = process.platform === "win32";
  const r = windows
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST])
    : await exec("ps", ["-A", "-o", "pid=,args="]);
  if (r.code !== 0) return [];
  return windows ? parseCim(r.stdout) : parsePs(r.stdout);
}

/** Spawns a detached supervisor or ensure-up loop that outlives this call; undefined when it could not start. */
export function spawnDetached(entry: string, cwd: string): number | undefined {
  const child = spawn(process.execPath, [entry], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return child.pid;
}

export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") await spawnExec("taskkill", ["/PID", String(pid), "/T", "/F"]);
  else
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
}

/** True once each file was written at or after `since` (one second of slack for coarse filesystem timestamps). */
export async function waitFresh(
  paths: readonly string[],
  since: number,
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  const fresh = (): boolean =>
    paths.every((path) => {
      try {
        return statSync(path).mtimeMs >= since - 1000;
      } catch {
        return false;
      }
    });
  while (now() < deadline) {
    if (fresh()) return true;
    await sleep(250);
  }
  return fresh();
}

/** Starts the supervisors that are not running and waits for their heartbeats; the ones already up are left alone. */
export async function ensureSupervisors(home: string, waitMs = 30_000): Promise<SupervisorHealth[]> {
  const procs = await listProcesses();
  const started = Date.now();
  const spawned: SupervisorName[] = [];
  for (const name of SUPERVISORS)
    if (matchPids(procs, ...entryPatterns(name)).length === 0) {
      if (spawnDetached(entryFor(home, name), home) !== undefined) spawned.push(name);
    }
  if (spawned.length > 0)
    await waitFresh(
      spawned.flatMap((name) => [heartbeatPath(home, name)]),
      started,
      { timeoutMs: waitMs },
    );
  return supervisorHealth(home);
}

/** Waits for the ensure-up loop to appear (the loops supervisor starts it), or returns its absent state at the deadline. */
export async function waitEnsureUp(home: string, wanted: boolean, timeoutMs = 15_000): Promise<EnsureUpHealth> {
  if (!wanted) return ensureUpHealth(home);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = ensureUpHealth(home);
    if (health.alive || Date.now() >= deadline) return health;
    await Bun.sleep(250);
  }
}

/** What `dori up` shows after it made sure the supervised half of the stack runs. */
export type SupervisedState = {
  readonly health: readonly SupervisorHealth[];
  readonly ensureUp: EnsureUpHealth;
  readonly off: boolean;
};

/**
 * Ensures the supervisors (unless the caller is opening its own loop panes) and the ensure-up loop, then waits briefly for
 * the loop's first beat. `dori up` prints this; nothing here opens a workspace.
 */
export async function superviseHome(
  home: string,
  opts: { readonly supervisors?: boolean } = {},
): Promise<SupervisedState> {
  const health = opts.supervisors === false ? supervisorHealth(home) : await ensureSupervisors(home);
  const off = ensureUpOff(home);
  let ensureUp = await waitEnsureUp(home, !off, opts.supervisors === false ? 0 : 15_000);
  if (!off && !ensureUp.alive) {
    spawnDetached(ensureUpEntry(home), home);
    ensureUp = await waitEnsureUp(home, true, 10_000);
  }
  return { health, ensureUp, off };
}

export type RestartResult = {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly killed: readonly number[];
  readonly health: readonly SupervisorHealth[];
  readonly ensureUp: EnsureUpHealth;
  readonly wsHeartbeatAgeMs?: number;
  readonly off: boolean;
};

/**
 * One command for the whole supervised half of the stack: kills every supervisor tree, starts them again, and waits
 * until the gateway heartbeat, the Discord socket heartbeat (`gateway-ws-heartbeat`) and the loops heartbeat are all
 * newer than the moment the restart began. The ensure-up loop comes back with the loops supervisor.
 */
export async function restartSupervisors(home: string, timeoutMs = 120_000): Promise<RestartResult> {
  const started = Date.now();
  const procs = await listProcesses();
  const killed = [...new Set(SUPERVISORS.flatMap((name) => matchPids(procs, ...entryPatterns(name)))).values()].filter(
    (pid) => pid !== process.pid,
  );
  for (const pid of killed) await killTree(pid);
  // The trees are dead before the replacements start, or the watchdog's duplicate check sees the old one and exits.
  for (let i = 0; i < 40 && killed.some(pidAlive); i++) await Bun.sleep(250);
  for (const name of SUPERVISORS) spawnDetached(entryFor(home, name), home);

  const ok = await waitFresh(
    [heartbeatPath(home, "gateway"), join(stateDir(home), WS_HEARTBEAT), heartbeatPath(home, "loops")],
    started,
    { timeoutMs },
  );
  const wanted = !ensureUpOff(home);
  const ensureUp = await waitEnsureUp(home, wanted, ok ? 15_000 : 0);
  const health = supervisorHealth(home);
  const gateway = health.find((h) => h.name === "gateway");
  const loops = health.find((h) => h.name === "loops");
  const children = (loops?.units ?? []).filter((u) => ["duty", "loop", "update-check"].includes(u.name) && u.alive);
  const gatewayChild = (gateway?.units ?? []).some((u) => u.name === "discord-gateway" && u.alive);
  const all =
    ok &&
    gateway?.alive === true &&
    gatewayChild &&
    loops?.alive === true &&
    children.length === 3 &&
    (!wanted || ensureUp.alive);
  const wsAge = ageMs(join(stateDir(home), WS_HEARTBEAT));
  return {
    ok: all,
    elapsedMs: Date.now() - started,
    killed,
    health,
    ensureUp,
    ...(wsAge !== undefined ? { wsHeartbeatAgeMs: wsAge } : {}),
    off: !wanted,
  };
}
