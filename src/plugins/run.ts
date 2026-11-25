import { homedir } from "node:os";
import { join } from "node:path";
import { joinContenders, leaveContenders, PLUGIN_TICK_MS, pluginCtx, type Plugin, type PluginCtx } from "./plugin.ts";
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

import { acquirePluginLock, releaseLockIfOwner, type LockRecordDeps } from "./lock.ts";

export { acquirePluginLock, lockHeldByRecord, releaseLockIfOwner } from "./lock.ts";
export type { LockRecordDeps } from "./lock.ts";

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
