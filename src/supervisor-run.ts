import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { spawnExec, type Exec } from "./runtime/exec.ts";
import {
  ageMs,
  entryFor,
  ensureUpHealth,
  ensureUpOff,
  heartbeatPath,
  pidAlive,
  stateDir,
  SUPERVISORS,
  supervisorHealth,
  UNIT_PATTERNS,
  WS_HEARTBEAT,
  type EnsureUpHealth,
  type SupervisorHealth,
  type SupervisorName,
} from "./supervisors.ts";
import { pluginRunEntry } from "./plugins/plugin.ts";
import { enabledPluginNames, isPluginEnabled } from "./plugins/state.ts";

/** A process the OS reports, with the command line `dori restart` matches against and its parent when the OS gives one. */
export type Proc = { readonly pid: number; readonly command: string; readonly parent?: number };

const SHIM: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor.ts",
  watchdog: "gateway-watchdog.ts",
};
const SOURCE: Readonly<Record<SupervisorName, string>> = {
  supervisor: "supervisor.ts",
  watchdog: "watchdog.ts",
};

/** What a process list is searched for: the installed shim, or the repo entry a dev checkout runs directly. */
const entryPatterns = (name: SupervisorName): readonly string[] =>
  name === "supervisor"
    ? [SHIM[name], `supervisors/${SOURCE[name]}`]
    : [SHIM[name], `supervisors/${SOURCE[name]}`, "supervisors\\watchdog.ts"];
export const matchPids = (procs: readonly Proc[] | undefined, ...patterns: readonly string[]): number[] =>
  (procs ?? []).filter((p) => patterns.some((s) => p.command.includes(s))).map((p) => p.pid);

const WINDOWS_LIST =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/** `ConvertTo-Json` output: one object when the OS found one bun, an array otherwise. */
export function parseCim(text: string): Proc[] {
  try {
    const parsed = JSON.parse(text.trim() || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      const r = (row ?? {}) as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
      const pid = Number(r.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const parent = Number(r.ParentProcessId);
      return [
        {
          pid,
          command: String(r.CommandLine ?? ""),
          ...(Number.isInteger(parent) && parent > 0 ? { parent } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** `ps -A -o pid=,ppid=,args=` (or the older two-column form): pid, optional parent pid, then the command line. */
export function parsePs(text: string): Proc[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(?:(\d+)\s+)?(.*)$/.exec(line);
    if (m === null) return [];
    const parent = m[2] === undefined ? undefined : Number(m[2]);
    return [{ pid: Number(m[1]), command: m[3] ?? "", ...(parent === undefined ? {} : { parent }) }];
  });
}

/** Every bun process with its command line and parent; undefined when the OS query fails (liveness is then unknown). */
export async function listProcesses(exec: Exec = spawnExec): Promise<Proc[] | undefined> {
  const windows = process.platform === "win32";
  const r = windows
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST])
    : await exec("ps", ["-A", "-o", "pid=,ppid=,args="]);
  if (r.code !== 0) return undefined;
  return windows ? parseCim(r.stdout) : parsePs(r.stdout);
}

/** Spawns a detached supervisor or plugin child that outlives this call; undefined when it could not start. */
export function spawnDetached(entry: string, cwd: string, args: readonly string[] = []): number | undefined {
  const child = spawn(process.execPath, [entry, ...args], {
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

/**
 * Kills the supervisor and every unit whose command line is one of the five children. Matching by command line, not
 * by the recorded pid, is what makes this safe after the supervisor itself has been dead long enough for Windows to
 * reuse a pid.
 */
export async function killSupervisorTree(procs?: readonly Proc[]): Promise<number[]> {
  const listed = procs ?? (await listProcesses()) ?? [];
  const pids = [...matchPids(listed, ...entryPatterns("supervisor")), ...matchPids(listed, ...UNIT_PATTERNS)];
  const killed = [...new Set(pids)].filter((pid) => pid !== process.pid);
  for (const pid of killed) await killTree(pid);
  return killed;
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

/** Waits for the ensure-up loop to appear (the supervisor starts it), or returns its absent state at the deadline. */
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
 * Ensures the supervisors (unless the caller is opening its own loop panes) and the ensure-up plugin, then waits briefly
 * for the first beat. `dori up` prints this; nothing here opens a workspace.
 */
export async function superviseHome(
  home: string,
  opts: { readonly supervisors?: boolean } = {},
): Promise<SupervisedState> {
  const health = opts.supervisors === false ? supervisorHealth(home) : await ensureSupervisors(home);
  const off = ensureUpOff(home);
  const wantUp = !off && isPluginEnabled(home, "ensure-up");
  let ensureUp = await waitEnsureUp(home, wantUp, opts.supervisors === false ? 0 : 15_000);
  // The supervisor owns the ensure-up plugin; only a pane-mode `dori up` starts it outside a supervisor.
  if (opts.supervisors === false && wantUp && !ensureUp.alive) {
    spawnDetached(pluginRunEntry(), home, ["ensure-up"]);
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
 * One command for the supervised half of the stack: kills the supervisor tree and any orphaned unit, starts one
 * supervisor again, and waits until the supervisor heartbeat, the Discord socket heartbeat (`gateway-ws-heartbeat`)
 * and all five units are up and newer than the moment the restart began.
 */
export async function restartSupervisors(home: string, timeoutMs = 120_000): Promise<RestartResult> {
  const started = Date.now();
  const killed = await killSupervisorTree();
  // The trees are dead before the replacements start, or the watchdog's duplicate check sees the old one and exits.
  for (let i = 0; i < 40 && killed.some(pidAlive); i++) await Bun.sleep(250);
  await ensureSupervisors(home, timeoutMs);

  const ok = await waitFresh([heartbeatPath(home, "supervisor"), join(stateDir(home), WS_HEARTBEAT)], started, {
    timeoutMs,
  });
  const wanted = !ensureUpOff(home) && isPluginEnabled(home, "ensure-up");
  const ensureUp = await waitEnsureUp(home, wanted, ok ? 15_000 : 0);
  const expected = ["discord-gateway", "duty", "loop", ...enabledPluginNames(home)];
  // Units started through panes register a moment after the supervisor's own heartbeat, so poll instead of reading once.
  const deadline = started + timeoutMs;
  let health = supervisorHealth(home);
  let supervisor = health.find((h) => h.name === "supervisor");
  let unitsUp = expected.every((name) => (supervisor?.units ?? []).some((u) => u.name === name && u.alive));
  while (!unitsUp && Date.now() < deadline) {
    await Bun.sleep(500);
    health = supervisorHealth(home);
    supervisor = health.find((h) => h.name === "supervisor");
    unitsUp = expected.every((name) => (supervisor?.units ?? []).some((u) => u.name === name && u.alive));
  }
  const all = ok && supervisor?.alive === true && unitsUp && (!wanted || ensureUp.alive);
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
