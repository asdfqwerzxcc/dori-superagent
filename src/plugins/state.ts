import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pidAlive, STALE_MS } from "../supervisors.ts";
import { statusCtx, type Plugin } from "./plugin.ts";
import { PLUGINS } from "./registry.ts";

export type PluginsConfig = { readonly disabled: readonly string[] };
export type PluginRecord = {
  readonly name: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly at: number;
};
export type PluginTick = { readonly pid: number; readonly at: number };
export type PluginHealth = {
  readonly name: string;
  readonly enabled: boolean;
  readonly pid?: number;
  readonly alive: boolean;
  readonly heartbeatAgeMs?: number;
  readonly detail: string;
};

export const pluginsConfigPath = (home: string): string => join(home, "state", "plugins.json");

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readPluginsConfig(home: string): PluginsConfig {
  const raw = readJson<{ disabled?: unknown }>(pluginsConfigPath(home));
  const disabled = Array.isArray(raw?.disabled) ? raw.disabled.filter((n): n is string => typeof n === "string") : [];
  return { disabled };
}

export function writePluginsConfig(home: string, config: PluginsConfig): void {
  writeJson(pluginsConfigPath(home), { disabled: [...config.disabled].sort() });
}

export function setPluginEnabled(home: string, name: string, enabled: boolean): PluginsConfig {
  const rest = readPluginsConfig(home).disabled.filter((n) => n !== name);
  return { disabled: enabled ? rest : [...rest, name] };
}

const disabledNow = (home: string): ReadonlySet<string> => new Set(readPluginsConfig(home).disabled);

export const isPluginEnabled = (home: string, name: string): boolean =>
  PLUGINS.some((p) => p.name === name) && !disabledNow(home).has(name);

export function enabledPluginNames(home: string): readonly string[] {
  const disabled = disabledNow(home);
  return PLUGINS.map((p) => p.name).filter((n) => !disabled.has(n));
}

const recordPath = (home: string, name: string): string => join(home, "state", "plugins", `${name}.json`);
const tickPath = (home: string, name: string): string => join(home, "state", "plugins", `${name}.tick`);

export const readPluginRecord = (home: string, name: string): PluginRecord | undefined =>
  readJson<PluginRecord>(recordPath(home, name));
export const writePluginRecord = (home: string, record: PluginRecord): void =>
  writeJson(recordPath(home, record.name), record);
export const removePluginRecord = (home: string, name: string): void => rmSync(recordPath(home, name), { force: true });

export const readPluginTick = (home: string, name: string): PluginTick | undefined =>
  readJson<PluginTick>(tickPath(home, name));

export function writePluginTick(home: string, name: string, at: number = Date.now()): void {
  writeJson(tickPath(home, name), { pid: process.pid, at });
}

export function pluginHealth(
  home: string,
  plugin: Plugin,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): PluginHealth {
  const record = readPluginRecord(home, plugin.name);
  const tick = readPluginTick(home, plugin.name);
  const pid = record?.pid ?? tick?.pid;
  const ages = [record, tick].flatMap((b) => (b === undefined ? [] : [now - b.at]));
  const beat = ages.length > 0 ? Math.min(...ages) : undefined;
  return {
    name: plugin.name,
    enabled: isPluginEnabled(home, plugin.name),
    ...(pid !== undefined ? { pid } : {}),
    alive: pid !== undefined && alive(pid) && beat !== undefined && beat <= STALE_MS,
    ...(beat !== undefined ? { heartbeatAgeMs: beat } : {}),
    detail: plugin.status(statusCtx(home, now)),
  };
}

const secs = (ms: number | undefined): string =>
  ms === undefined || !Number.isFinite(ms) ? "missing" : `${Math.max(0, Math.round(ms / 1000))}s`;

export function formatPlugin(h: PluginHealth): string {
  if (!h.enabled) return `PLUGIN ${h.name} disabled`;
  const note = h.detail === "" ? "" : ` (${h.detail})`;
  return `PLUGIN ${h.name} ${h.alive ? "up" : "DOWN"} pid=${h.pid ?? "?"} hb=${secs(h.heartbeatAgeMs)}${note}`;
}

export function pluginLines(
  home: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  return PLUGINS.map((p) => pluginHealth(home, p, now, alive))
    .filter((h) => h.enabled)
    .map(formatPlugin);
}

export function pluginListLines(
  home: string,
  now: number = Date.now(),
  alive: (pid: number) => boolean = pidAlive,
): string[] {
  return PLUGINS.map((p) => formatPlugin(pluginHealth(home, p, now, alive)));
}
