import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pidAlive, processStartTimeMs } from "../process-liveness.ts";
import {
  joinContenders,
  leaveContenders,
  PLUGIN_TICK_MS,
  pluginCtx,
  START_SLACK_MS,
  type Plugin,
  type PluginCtx,
} from "./plugin.ts";
import { pluginByName } from "./registry.ts";
import { isPluginEnabled, writePluginTick } from "./state.ts";

export type TickOptions = {
  readonly ticks?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export async function runTicks(plugin: Plugin, ctx: PluginCtx, opts: TickOptions = {}): Promise<number> {
  const interval = opts.intervalMs ?? plugin.intervalMs ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  let ran = 0;
  for (;;) {
    try {
      await plugin.run(ctx);
    } catch (e) {
      ctx.log(`PLUGIN_WARN ${plugin.name} ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
    ran += 1;
    if (opts.ticks !== undefined && ran >= opts.ticks) return ran;
    await sleep(interval);
  }
}

export type LockRecordDeps = {
  readonly alive?: (pid: number) => boolean;
  readonly started?: (pid: number) => number | null;
};

const ownerPath = (lock: string): string => join(lock, "owner.json");

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The lock is a directory now; an older file at the same path is still read for migration. */
const readLockRecord = (lock: string): Record<string, unknown> | undefined =>
  readJson(ownerPath(lock)) ?? readJson(lock);

/**
 * A version 1 lock is held only by the process that wrote it: its start time is compared with the live pid. A
 * non-null mismatch is a reused pid (stale); an unreadable start time or a null recorded one is doubt, so it stays held.
 * An unversioned old-format lock is unverifiable and is taken over once on upgrade.
 */
export function lockHeldByRecord(raw: unknown, deps: LockRecordDeps = {}): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const record = raw as { version?: unknown; pid?: unknown; startedAt?: unknown };
  const version = Number(record.version);
  if (version !== 1) return false;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!(deps.alive ?? pidAlive)(pid)) return false;
  const startedAt = Number(record.startedAt);
  if (!Number.isInteger(startedAt) || startedAt <= 0) return true;
  const started = (deps.started ?? processStartTimeMs)(pid);
  if (started === null) return true;
  return Math.abs(started - startedAt) <= START_SLACK_MS;
}

const selfHeld = (lock: string): boolean => {
  const record = readJson(ownerPath(lock));
  if (record === undefined) return false;
  if (Number(record["version"]) !== 1 || Number(record["pid"]) !== process.pid) return false;
  const startedAt = Number(record["startedAt"]);
  const own = processStartTimeMs(process.pid);
  if (!Number.isInteger(startedAt)) return true;
  return own === null || Math.abs(own - startedAt) <= START_SLACK_MS;
};

const dirAgeMs = (lock: string): number | null => {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return null;
  }
};

export function acquirePluginLock(lock: string, deps: LockRecordDeps = {}): boolean {
  mkdirSync(dirname(lock), { recursive: true });
  const claim = (): boolean => {
    try {
      mkdirSync(lock);
    } catch {
      return false;
    }
    try {
      writeFileSync(
        ownerPath(lock),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          at: Date.now(),
          startedAt: processStartTimeMs(process.pid) ?? null,
        }),
      );
    } catch {}
    return selfHeld(lock);
  };
  if (claim()) return true;
  const record = readLockRecord(lock);
  if (record !== undefined) {
    if (lockHeldByRecord(record, deps)) return false;
  } else {
    // An ownerless directory is a claim in progress; only an old one is abandoned.
    const age = dirAgeMs(lock);
    if (age !== null && age < 30_000) return false;
  }
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {}
  return claim();
}

/** Removes the lock only while it still names this process; a takeover's lock is left alone. */
export function releaseLockIfOwner(lock: string): void {
  const record = readJson(ownerPath(lock)) ?? readJson(lock);
  if (record === undefined || Number(record["pid"]) !== process.pid) return;
  try {
    rmSync(ownerPath(lock), { force: true });
    rmSync(lock, { recursive: true, force: true });
  } catch {}
}

const LOCK_RETRY_MS = 5_000;

export type WaitPluginLockOptions = {
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly wanted?: () => boolean;
  readonly lockDeps?: LockRecordDeps;
};

/**
 * Waits until this child holds the plugin lock; a losing child records and refreshes itself as a contender and retries.
 * It never exits because ensure-up is switched off: the loop then idles, and a supervised child would otherwise be
 * restarted every 5 s. Only a disabled plugin makes it leave.
 */
export async function waitPluginLock(
  home: string,
  name: string,
  lockPath: string,
  opts: WaitPluginLockOptions,
): Promise<boolean> {
  const wanted = opts.wanted ?? (() => true);
  let warned = false;
  for (;;) {
    if (!wanted()) {
      leaveContenders(home, name);
      return false;
    }
    if (acquirePluginLock(lockPath, opts.lockDeps ?? {})) {
      if (!wanted()) {
        releaseLockIfOwner(lockPath);
        leaveContenders(home, name);
        return false;
      }
      leaveContenders(home, name);
      return true;
    }
    joinContenders(home, name);
    if (!warned) {
      opts.log(`PLUGIN ${name} already running in another child`);
      warned = true;
    }
    await opts.sleep(LOCK_RETRY_MS);
  }
}

/**
 * The child `src/plugins/run.ts <name>` starts: one lock per plugin per home, a liveness beat every 30 s, then the ticks.
 * A duplicate child records itself as a contender (refreshing its at each retry) and retries the lock, so a stale lock
 * cannot turn into a restart loop and an idle loop is not restarted; only a disabled plugin makes it leave.
 */
export async function runPluginChild(
  name: string,
  opts: { home?: string; ticks?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<number> {
  const plugin = pluginByName(name);
  if (plugin === undefined) {
    process.stderr.write(`PLUGIN_UNKNOWN ${name}\n`);
    return 64;
  }
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const ctx = pluginCtx(home, plugin.name);
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  process.once("exit", () => leaveContenders(home, plugin.name));
  const held = await waitPluginLock(home, plugin.name, ctx.lockPath, {
    sleep,
    log: ctx.log,
    wanted: () => isPluginEnabled(home, plugin.name),
  });
  if (!held) {
    ctx.log(`PLUGIN ${plugin.name} disabled; exiting`);
    return 0;
  }
  process.once("exit", () => {
    releaseLockIfOwner(ctx.lockPath);
    leaveContenders(home, plugin.name);
  });
  const beat = () => {
    try {
      writePluginTick(home, plugin.name);
    } catch {}
  };
  beat();
  const timer = setInterval(beat, PLUGIN_TICK_MS);
  timer.unref();
  ctx.log(`PLUGIN ${plugin.name} start pid=${process.pid} intervalMs=${plugin.intervalMs ?? "self"}`);
  const ran = await runTicks(plugin, ctx, opts.ticks === undefined ? {} : { ticks: opts.ticks });
  clearInterval(timer);
  ctx.log(`PLUGIN ${plugin.name} ticks=${ran}`);
  return 0;
}

if (import.meta.main) process.exit(await runPluginChild(process.argv[2] ?? ""));
