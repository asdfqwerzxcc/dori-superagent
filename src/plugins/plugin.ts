import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
