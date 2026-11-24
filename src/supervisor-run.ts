import { spawn } from "node:child_process";
import { join } from "node:path";
import { PLUGINS } from "./plugins/registry.ts";
import { pluginRunEntry } from "./plugins/plugin.ts";
import { enabledPluginNames, isPluginEnabled, readPluginRecord } from "./plugins/state.ts";
import { acquirePidLock } from "./pid-lock.ts";
import { pidAlive, processStartTimeMs, startedNear, terminateProcess } from "./process-liveness.ts";
import {
  ageMs,
  ensureUpHealth,
  ensureUpOff,
  ensureUpRecord,
  entryFor,
  freshSince,
  heartbeatPath,
  restartMissing,
  stateDir,
  STALE_MS,
  SUPERVISORS,
  supervisorHealth,
  supervisorRecord,
  WS_HEARTBEAT,
  type EnsureUpHealth,
  type SupervisorHealth,
  type SupervisorName,
} from "./supervisors.ts";

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

/** Ends one recorded pid through kernel32.TerminateProcess on Windows, SIGTERM on POSIX (no taskkill console child). */
export async function killTree(pid: number): Promise<void> {
  terminateProcess(pid);
}

/** A recorded child and the moment it started, so a reused pid is not mistaken for the record. */
export type RecordedChild = { readonly pid: number; readonly at: number };

/** Every pid the records claim as a child: supervisor units, plugin children and the ensure-up loop. */
export function recordedChildren(home: string): RecordedChild[] {
  const out = new Map<number, number>();
  for (const unit of supervisorRecord(home, "supervisor")?.units ?? []) out.set(unit.pid, unit.at);
  for (const plugin of PLUGINS) {
    const record = readPluginRecord(home, plugin.name);
    if (record !== undefined) out.set(record.pid, record.startedAt);
  }
  const ensureUp = ensureUpRecord(home);
  if (ensureUp !== undefined) out.set(ensureUp.pid, ensureUp.startedAt);
  return [...out].map(([pid, at]) => ({ pid, at }));
}

/** Alive and still the process the record named; an unreadable start time is doubt, not evidence of a reused pid. */
export function recordedAlive(child: RecordedChild): boolean {
  if (child.pid === process.pid || !pidAlive(child.pid)) return false;
  const started = processStartTimeMs(child.pid);
  return started === null || Math.abs(started - child.at) <= 10_000;
}

export type KillTreeOptions = {
  readonly alive?: (child: RecordedChild) => boolean;
  readonly kill?: (pid: number) => boolean;
};

/**
 * Kills the supervisor and every child its records name. The record is the only source: a pid is taken when it is alive
 * and its OS start time matches the recorded moment, so a pid Windows reused for another process is left alone.
 */
export async function killSupervisorTree(home: string, deps: KillTreeOptions = {}): Promise<number[]> {
  const alive = deps.alive ?? recordedAlive;
  const kill = deps.kill ?? terminateProcess;
  const candidates = new Map<number, number>();
  const record = supervisorRecord(home, "supervisor");
  if (record !== undefined) candidates.set(record.pid, record.startedAt);
  for (const child of recordedChildren(home)) if (!candidates.has(child.pid)) candidates.set(child.pid, child.at);
  const killed = [...candidates].filter(([pid, at]) => pid !== process.pid && alive({ pid, at })).map(([pid]) => pid);
  for (const pid of killed) kill(pid);
  return killed;
}

/**
 * Claims the one supervisor slot for a home. A lock held by a live pid, or a recorded supervisor whose start time
 * matches and whose beat is fresh, refuses (`already_running`); a dead record's children are terminated first so the
 * new supervisor cannot inherit orphans. Returns undefined when the slot is this process's.
 */
export function claimSupervisor(home: string, state: string): string | undefined {
  if (!acquirePidLock(join(state, "supervisor.lock"))) return "already_running lock=1";
  const previous = supervisorRecord(home, "supervisor");
  if (previous !== undefined && previous.pid !== process.pid && startedNear(previous.pid, previous.startedAt)) {
    const fresh = (ageMs(heartbeatPath(home, "supervisor")) ?? Infinity) <= STALE_MS;
    if (fresh) return `already_running pids=${previous.pid}`;
    terminateProcess(previous.pid);
  }
  for (const child of recordedChildren(home)) if (recordedAlive(child)) terminateProcess(child.pid);
  return undefined;
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

export type EnsureSupervisorsOptions = {
  readonly spawn?: typeof spawnDetached;
  readonly alive?: (pid: number) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
};

/** Starts the supervisors whose record is absent or dead; a live recorded one is left alone (no process scan). */
export async function ensureSupervisors(
  home: string,
  waitMs = 30_000,
  deps: EnsureSupervisorsOptions = {},
): Promise<SupervisorHealth[]> {
  const spawnOne = deps.spawn ?? spawnDetached;
  const alive = deps.alive ?? pidAlive;
  const started = Date.now();
  const spawned: SupervisorName[] = [];
  for (const name of SUPERVISORS) {
    const record = supervisorRecord(home, name);
    if (record !== undefined && alive(record.pid)) continue;
    if (spawnOne(entryFor(home, name), home) !== undefined) spawned.push(name);
  }
  if (spawned.length > 0)
    await waitFresh(
      spawned.map((name) => heartbeatPath(home, name)),
      started,
      { timeoutMs: waitMs, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) },
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
 * One command for the supervised half of the stack: kills the recorded supervisor tree and any orphaned unit, starts
 * one supervisor again, and waits until the supervisor heartbeat, the Discord socket heartbeat (`gateway-ws-heartbeat`)
 * and all units are up and newer than the moment the restart began. A failed attempt is retried once, and the second
 * verdict names every piece that is still missing and why.
 */
export async function restartSupervisors(
  home: string,
  opts: { readonly timeoutMs?: number; readonly io?: Partial<RestartIo> } = {},
): Promise<RestartResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const io: RestartIo = {
    kill: () => killSupervisorTree(home),
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
