import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGINS } from "../plugins/registry.ts";
import { pluginRunEntry } from "../plugins/plugin.ts";
import { isPluginEnabled, removePluginRecord, writePluginRecord } from "../plugins/state.ts";
import { killTree, listProcesses, matchPids } from "../supervisor-run.ts";
import { stateDir, UNIT_PATTERNS, writeSupervisorRecord, type UnitRecord } from "../supervisors.ts";
import { runPluginUnit } from "./plugins.ts";

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
 * exception in one cannot take the delivery path down with it. Output: `SUPERVISED <event>` lines; one record
 * (state/supervisor.json) and one beat (state/supervisor-heartbeat) every 30 s, plus a gateway-heartbeat compatibility
 * write for the Windows boot guard.
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

  const specs: readonly Unit[] = [
    { name: "discord-gateway", entry: (h) => join(h, "bin", "discord-gateway.ts"), args: [], log: "gateway" },
    { name: "duty", entry: () => cli, args: ["duty", "--interval", "60"], log: "loops" },
    { name: "loop", entry: () => cli, args: ["loop"], log: "loops" },
  ];

  const runUnit = async (spec: Unit): Promise<never> => {
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

  for (const plugin of PLUGINS) {
    void runPluginUnit({
      name: plugin.name,
      spawnChild: () => spawnPlugin(plugin.name),
      stopChild: (pid) => killTree(pid),
      isEnabled: () => isPluginEnabled(home, plugin.name),
      onStart: (pid) => {
        const at = Date.now();
        pluginStarted.set(plugin.name, at);
        units.set(plugin.name, { name: plugin.name, pid, at });
        writePluginRecord(home, { name: plugin.name, pid, startedAt: at, at });
        write();
      },
      onStop: () => {
        pluginStarted.delete(plugin.name);
        units.delete(plugin.name);
        removePluginRecord(home, plugin.name);
        write();
      },
      log,
      sleep,
    });
  }

  log(`SUPERVISED ready units=${ORDER.join(",")} cli=${cli}`);
  for (const spec of specs) void runUnit(spec);
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

if (import.meta.main) await runSupervisor();
