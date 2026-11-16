import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pidAlive } from "../supervisors.ts";
import { PLUGIN_TICK_MS, pluginCtx, type Plugin, type PluginCtx } from "./plugin.ts";
import { pluginByName } from "./registry.ts";
import { writePluginTick } from "./state.ts";

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

export function acquirePluginLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const write = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  try {
    const pid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid);
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) return false;
  } catch {}
  rmSync(path, { force: true });
  return write();
}

/**
 * The child `src/plugins/run.ts <name>` starts: one lock per plugin per home, a liveness beat every 30 s, then the ticks.
 * A duplicate child logs once and idles instead of exiting, so a stale lock cannot turn into a restart loop.
 */
export async function runPluginChild(name: string, opts: { home?: string; ticks?: number } = {}): Promise<number> {
  const plugin = pluginByName(name);
  if (plugin === undefined) {
    process.stderr.write(`PLUGIN_UNKNOWN ${name}\n`);
    return 64;
  }
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const ctx = pluginCtx(home, plugin.name);
  if (!acquirePluginLock(ctx.lockPath)) {
    ctx.log(`PLUGIN ${plugin.name} already running in another child`);
    await new Promise<never>(() => {});
  }
  process.once("exit", () => rmSync(ctx.lockPath, { force: true }));
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
