import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, processStartTimeMs } from "../process-liveness.ts";

// The plugin contract and the files one plugin owns under state/plugins/. A plugin is a timed side-job, not the
// delivery path: the supervisor runs each one as its own child, so a throw here can never reach duty or the gateway.
// Everything a plugin needs arrives in PluginCtx; `status` is a read-only phrase for the one `dori status` line.

export type PluginCtx = {
  readonly home: string;
  readonly stateDir: string;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** One child per plugin per home: the host holds this before the first tick. */
  readonly lockPath: string;
  /** The host rewrites this every 30 s; a hung tick cannot fake it. */
  readonly tickPath: string;
  /** The child's start, so a per-tick record keeps one origin. */
  readonly startedAt: number;
};

/** `dori status` asks each plugin for one phrase; no side effects, no process work. */
export type PluginStatusCtx = { readonly home: string; readonly stateDir: string; readonly at: number };

export type Plugin = {
  readonly name: string;
  /** Tick period; absent means the plugin schedules itself inside `run`. */
  readonly intervalMs?: number;
  /** One tick. A throw is logged by the host and never stops the loop. */
  readonly run: (ctx: PluginCtx) => Promise<void>;
  /** A short phrase for the status line, from the plugin's own files. Empty prints no phrase. */
  readonly status: (ctx: PluginStatusCtx) => string;
};

/** The liveness beat the host writes whatever the tick period is, so three missed beats mean dead. */
export const PLUGIN_TICK_MS = 30_000;

export const pluginDir = (home: string): string => join(home, "state", "plugins");
export const pluginPath = (home: string, name: string, ext: "json" | "tick" | "lock"): string =>
  join(pluginDir(home), `${name}.${ext}`);

/** One file per plugin child that idled on a lock another live child holds, so a duplicate stays visible. */
export const contendersDir = (home: string, name: string): string => join(pluginDir(home), `${name}.contenders`);

export type Contender = { readonly pid: number; readonly at: number };

/** The OS start time is stable for a pid; a different value means the pid was reused. */
export const START_SLACK_MS = 2_000;

const contenderPath = (home: string, name: string, pid: number): string =>
  join(contendersDir(home, name), `${pid}.json`);

export type JoinContendersDeps = { readonly started?: (pid: number) => number | null };

export function joinContenders(
  home: string,
  name: string,
  pid: number = process.pid,
  deps: JoinContendersDeps = {},
): void {
  const at = (deps.started ?? processStartTimeMs)(pid);
  if (at === null) return;
  try {
    mkdirSync(contendersDir(home, name), { recursive: true });
    writeFileSync(contenderPath(home, name, pid), JSON.stringify({ pid, at }));
  } catch {}
}

export function leaveContenders(home: string, name: string, pid: number = process.pid): void {
  try {
    rmSync(contenderPath(home, name, pid), { force: true });
  } catch {}
}

export type PluginLock = Contender & { readonly startedAt?: number };

/** The lock's holder: a version 1 owner inside the lock directory, or an older file for migration. */
export function readPluginLock(home: string, name: string): PluginLock | undefined {
  const lock = pluginPath(home, name, "lock");
  const read = (path: string): Record<string, unknown> | undefined => {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const raw = read(join(lock, "owner.json")) ?? read(lock);
  if (raw === undefined) return undefined;
  const pid = Number(raw["pid"]);
  const at = Number(raw["at"]);
  const startedAt = Number(raw["startedAt"]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(at)) return undefined;
  return { pid, at, ...(Number.isInteger(startedAt) && startedAt > 0 ? { startedAt } : {}) };
}

/** A contender is evidence only while the pid is alive and its OS start time matches the recorded moment. */
export type ContenderAliveDeps = {
  readonly alive?: (pid: number) => boolean;
  readonly started?: (pid: number) => number | null;
};

export function contenderAlive(c: Contender, deps: ContenderAliveDeps = {}): boolean {
  if (c.pid === process.pid || !(deps.alive ?? pidAlive)(c.pid)) return false;
  const started = (deps.started ?? processStartTimeMs)(c.pid);
  return started !== null && Math.abs(started - c.at) <= START_SLACK_MS;
}

export type ReadContendersOptions = { readonly same?: (c: Contender) => boolean };

/** Live, start-time-matched contenders; a dead or reused pid's file is removed, never trusted. */
export function readContenders(home: string, name: string, opts: ReadContendersOptions = {}): Contender[] {
  const same = opts.same ?? contenderAlive;
  const dir = contendersDir(home, name);
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const live: Contender[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    let contender: Contender | undefined;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
      const pid = Number(raw.pid);
      const at = Number(raw.at);
      if (Number.isInteger(pid) && pid > 0 && Number.isInteger(at) && at > 0) contender = { pid, at };
    } catch {}
    if (contender !== undefined && same(contender)) {
      live.push(contender);
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch {}
  }
  return live;
}

/** The child the supervisor spawns: `bun src/plugins/run.ts <name>`. */
export const pluginRunEntry = (): string => join(import.meta.dir, "run.ts");

export function pluginCtx(home: string, name: string): PluginCtx {
  mkdirSync(pluginDir(home), { recursive: true });
  return {
    home,
    stateDir: join(home, "state"),
    now: Date.now,
    log: (line) => process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`),
    lockPath: pluginPath(home, name, "lock"),
    tickPath: pluginPath(home, name, "tick"),
    startedAt: Date.now(),
  };
}

export const statusCtx = (home: string, at: number = Date.now()): PluginStatusCtx => ({
  home,
  stateDir: join(home, "state"),
  at,
});
