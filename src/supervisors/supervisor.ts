import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGINS } from "../plugins/registry.ts";
import { pluginRunEntry } from "../plugins/plugin.ts";
import { isPluginEnabled, removePluginRecord, writePluginRecord } from "../plugins/state.ts";
import { killTree, listProcesses, matchPids } from "../supervisor-run.ts";
import { pidAlive, stateDir, UNIT_PATTERNS, writeSupervisorRecord, type UnitRecord } from "../supervisors.ts";
import { openUnitPanes } from "./ops-panes.ts";
import type { PaneUnit } from "./panes.ts";
import { runPluginUnit } from "./plugins.ts";
import { paneCommand, runUnitInPane } from "./units.ts";

const RESTART_MS = 5_000;
const BEAT_MS = 30_000;

type CoreName = "discord-gateway" | "duty" | "loop";
const CORE: readonly CoreName[] = ["discord-gateway", "duty", "loop"];
const ORDER: readonly string[] = [...CORE, ...PLUGINS.map((p) => p.name)];

type Unit = {
  readonly name: CoreName;
  readonly entry: (home: string, cli: string) => string;
  readonly args: readonly string[];
  readonly log: "gateway" | "loops";
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One supervisor for every long-lived child: the Discord gateway, duty and the hourly loop stay core, and ensure-up,
 * update-check and gateway-catchup run as plugin children from the registry. Each child stays a separate process, so an
 * exception in one cannot take the delivery path down with it. On a runtime that answers, each unit runs as a plain
 * command in its own titled pane in the `dori-ops` workspace; a missing or broken runtime falls back to the same
 * headless children with one warning line. Output: `SUPERVISED <event>` lines; one record (state/supervisor.json) and
 * one beat (state/supervisor-heartbeat) every 30 s, plus a gateway-heartbeat compatibility write for the boot guard.
 */
export async function runSupervisor(): Promise<never> {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  const cli = join(import.meta.dir, "..", "cli.ts");
  const pluginRun = pluginRunEntry();
  const logs = {
    gateway: createWriteStream(join(state, "gateway.log"), { flags: "a" }),
    loops: createWriteStream(join(state, "loops.log"), { flags: "a" }),
    supervisor: createWriteStream(join(state, "supervisor.log"), { flags: "a" }),
  };
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (line: string) => {
    const text = `${stamp()} ${line}\n`;
    logs.supervisor.write(text);
    process.stdout.write(text);
  };

  const procs = await listProcesses();
  const duplicates = matchPids(procs, "supervisor.ts").filter((pid) => pid !== process.pid);
  if (duplicates.length > 0) {
    log(`SUPERVISOR_EXIT already_running pids=${duplicates.join(",")}`);
    process.exit(0);
  }
  // A supervisor that died leaves its children running on Windows; take their command lines back before spawning.
  for (const pid of matchPids(procs, ...UNIT_PATTERNS)) await killTree(pid);

  const units = new Map<string, UnitRecord>();
  const pluginStarted = new Map<string, number>();
  const list = (): UnitRecord[] =>
    ORDER.flatMap((name) => {
      const unit = units.get(name);
      return unit === undefined ? [] : [unit];
    });
  const startedAt = Date.now();
  const write = () =>
    writeSupervisorRecord(home, { name: "supervisor", pid: process.pid, startedAt, units: list(), at: Date.now() });
  const beat = () => {
    const at = new Date().toISOString();
    try {
      writeFileSync(join(state, "supervisor-heartbeat"), at);
      // The DoriGatewayGuard task still reads gateway-heartbeat; keep the compatibility file in lockstep.
      writeFileSync(join(state, "gateway-heartbeat"), at);
    } catch {}
    write();
    for (const unit of units.values()) {
      const began = pluginStarted.get(unit.name);
      if (began === undefined) continue;
      writePluginRecord(home, { name: unit.name, pid: unit.pid, startedAt: began, at: Date.now() });
    }
  };
  beat();
  setInterval(beat, BEAT_MS).unref();

  const panes = await openUnitPanes({ home, env: process.env, log, sleep });
  const paneUnit = (name: string, entry: string, args: readonly string[]): PaneUnit => ({
    name,
    command: paneCommand(process.execPath, [entry, ...args], panes?.shell ?? "sh"),
    marker: [entry, ...args],
  });

  const specs: readonly Unit[] = [
    { name: "discord-gateway", entry: (h) => join(h, "bin", "discord-gateway.ts"), args: [], log: "gateway" },
    { name: "duty", entry: () => cli, args: ["duty", "--interval", "60"], log: "loops" },
    { name: "loop", entry: () => cli, args: ["loop"], log: "loops" },
  ];

  const runHeadless = async (spec: Unit): Promise<never> => {
    for (;;) {
      const child = spawn(process.execPath, [spec.entry(home, cli), ...spec.args], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: home,
        windowsHide: true,
        env: { ...process.env, DORI_HOME: home, DORI_VERIFY_PROMPT: "1" },
      });
      const pid = child.pid;
      if (pid !== undefined) {
        units.set(spec.name, { name: spec.name, pid, at: Date.now() });
        write();
      }
      const emit = (chunk: Buffer) => logs[spec.log].write(chunk);
      child.stdout?.on("data", emit);
      child.stderr?.on("data", emit);
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (c) => resolve(c));
        child.on("error", () => resolve(null));
      });
      units.delete(spec.name);
      write();
      log(`SUPERVISED ${spec.name}_exit code=${code}`);
      await sleep(RESTART_MS);
    }
  };

  const spawnPlugin = (name: string) => {
    const child = spawn(process.execPath, [pluginRun, name], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: home,
      windowsHide: true,
      env: { ...process.env, DORI_HOME: home, DORI_VERIFY_PROMPT: "1" },
    });
    const emit = (chunk: Buffer) => logs.loops.write(chunk);
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    return child;
  };

  const pluginStart =
    (name: string) =>
    (pid: number, pane?: string): void => {
      const at = Date.now();
      pluginStarted.set(name, at);
      units.set(name, { name, pid, at, ...(pane === undefined ? {} : { pane }) });
      writePluginRecord(home, { name, pid, startedAt: at, at });
      write();
    };
  const pluginStop = (name: string) => (): void => {
    pluginStarted.delete(name);
    units.delete(name);
    removePluginRecord(home, name);
    write();
  };

  for (const plugin of PLUGINS) {
    const enabled = () => isPluginEnabled(home, plugin.name);
    const headless = () =>
      runPluginUnit({
        name: plugin.name,
        spawnChild: () => spawnPlugin(plugin.name),
        stopChild: (pid) => killTree(pid),
        isEnabled: enabled,
        onStart: (pid) => pluginStart(plugin.name)(pid),
        onStop: pluginStop(plugin.name),
        log,
        sleep,
      });
    if (panes === undefined) {
      void headless();
      continue;
    }
    const unit = paneUnit(plugin.name, pluginRun, [plugin.name]);
    void runUnitInPane({
      name: plugin.name,
      place: () => panes.units.place(unit),
      close: (pane) => panes.units.close(pane),
      headless,
      enabled,
      onStart: (placed) => pluginStart(plugin.name)(placed.pid, placed.pane.id),
      onExit: pluginStop(plugin.name),
      alive: pidAlive,
      log,
      sleep,
    });
  }

  const startCore = (spec: Unit): void => {
    const headless = () => runHeadless(spec);
    if (panes === undefined) {
      void headless();
      return;
    }
    const entry = spec.entry(home, cli);
    if (!existsSync(entry)) {
      log(`SUPERVISED ${spec.name}_entry_missing path=${entry} headless=1`);
      void headless();
      return;
    }
    const unit = paneUnit(spec.name, entry, spec.args);
    void runUnitInPane({
      name: spec.name,
      place: () => panes.units.place(unit),
      close: (pane) => panes.units.close(pane),
      headless,
      onStart: (placed) => {
        units.set(spec.name, { name: spec.name, pid: placed.pid, at: Date.now(), pane: placed.pane.id });
        write();
      },
      onExit: () => {
        units.delete(spec.name);
        write();
      },
      alive: pidAlive,
      log,
      sleep,
    });
  };

  log(`SUPERVISED ready units=${ORDER.join(",")} cli=${cli}`);
  for (const spec of specs) startCore(spec);
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

if (import.meta.main) await runSupervisor();
