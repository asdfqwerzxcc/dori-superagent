import { spawn } from "node:child_process";
import { join } from "node:path";
import { spawnExec } from "./runtime/exec.ts";
import { listProcesses, matchPids, type Proc } from "./process-list.ts";
import {
  ageMs,
  entryFor,
  ensureUpHealth,
  ensureUpOff,
  freshSince,
  heartbeatPath,
  pidAlive,
  restartMissing,
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

export { listProcesses, matchPids, parseCim, parsePs, type Proc } from "./process-list.ts";

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
  const fresh = (): boolean => paths.every((path) => freshSince(path, since));
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
 * Starts the supervisors that are missing (`startMissing`) or only reads their health, then reports the ensure-up
 * plugin and waits briefly for its first beat. `dori up` prints this; nothing here opens a workspace.
 */
export async function superviseHome(home: string, opts: { readonly startMissing: boolean }): Promise<SupervisedState> {
  const health = opts.startMissing ? await ensureSupervisors(home) : supervisorHealth(home);
  const off = ensureUpOff(home);
  const wantUp = !off && isPluginEnabled(home, "ensure-up");
  const supervised = health.some((h) => h.name === "supervisor" && h.alive);
  let ensureUp = await waitEnsureUp(home, wantUp, supervised ? 15_000 : 0);
  // The supervisor owns the ensure-up plugin; only a pane-mode `dori up` starts it outside a supervisor.
  if (!supervised && wantUp && !ensureUp.alive) {
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
  readonly retried: boolean;
  readonly missing: readonly string[];
};

/** What a restart needs from outside; tests replace it to drive a partial failure and its retry without real processes. */
type RestartIo = {
  readonly kill: () => Promise<readonly number[]>;
  readonly ensure: (home: string, waitMs: number) => Promise<readonly SupervisorHealth[]>;
  readonly health: (home: string) => readonly SupervisorHealth[];
  readonly waitFresh: (paths: readonly string[], since: number, waitMs: number) => Promise<boolean>;
  readonly waitEnsureUp: (home: string, wanted: boolean, waitMs: number) => Promise<EnsureUpHealth>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

/**
 * One command for the supervised half of the stack: kills the supervisor tree and any orphaned unit, starts one
 * supervisor again, and waits until the supervisor heartbeat, the Discord socket heartbeat (`gateway-ws-heartbeat`)
 * and all units are up and newer than the moment the restart began. A failed attempt is retried once, and the second
 * verdict names every piece that is still missing and why.
 */
export async function restartSupervisors(
  home: string,
  opts: { readonly timeoutMs?: number; readonly io?: Partial<RestartIo> } = {},
): Promise<RestartResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const io: RestartIo = {
    kill: killSupervisorTree,
    ensure: ensureSupervisors,
    health: supervisorHealth,
    waitFresh: (paths, since, waitMs) => waitFresh(paths, since, { timeoutMs: waitMs }),
    waitEnsureUp,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    ...opts.io,
  };
  const started = io.now();
  const killed = await io.kill(); // A replacement must not start while an old tree lives, or it exits as a duplicate.
  for (let i = 0; i < 40 && killed.some(pidAlive); i++) await io.sleep(250);
  const expected = ["discord-gateway", "duty", "loop", ...enabledPluginNames(home)];
  const wanted = !ensureUpOff(home) && isPluginEnabled(home, "ensure-up");
  const beats = [heartbeatPath(home, "supervisor"), join(stateDir(home), WS_HEARTBEAT)];
  const settle = async () => {
    const fresh = await io.waitFresh(beats, started, timeoutMs);
    const ensureUp = await io.waitEnsureUp(home, wanted, fresh ? 15_000 : 0);
    const deadline = io.now() + timeoutMs;
    let health = io.health(home);
    const unitsUp = (h: readonly SupervisorHealth[]): boolean => {
      const units = h.find((s) => s.name === "supervisor")?.units ?? [];
      return expected.every((name) => units.some((u) => u.name === name && u.alive));
    };
    // Units started through panes register a moment after the supervisor's own heartbeat, so poll instead of reading once.
    while (!unitsUp(health) && io.now() < deadline) {
      await io.sleep(500);
      health = io.health(home);
    }
    const supervisor = health.find((h) => h.name === "supervisor");
    const ok = fresh && supervisor?.alive === true && unitsUp(health) && (!wanted || ensureUp.alive);
    return { health, ensureUp, ok };
  };
  await io.ensure(home, timeoutMs);
  let attempt = await settle();
  const retried = !attempt.ok;
  if (retried) {
    await io.ensure(home, timeoutMs);
    attempt = await settle();
  }
  const now = io.now();
  const wsAge = ageMs(beats[1]!, now);
  return {
    ok: attempt.ok,
    elapsedMs: now - started,
    killed,
    health: attempt.health,
    ensureUp: attempt.ensureUp,
    ...(wsAge !== undefined ? { wsHeartbeatAgeMs: wsAge } : {}),
    off: !wanted,
    retried,
    missing: attempt.ok
      ? []
      : restartMissing({
          home,
          since: started,
          expected,
          wanted,
          health: attempt.health,
          ensureUp: attempt.ensureUp,
          now,
        }),
  };
}
