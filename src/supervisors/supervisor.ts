import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killTree, listProcesses, matchPids } from "../supervisor-run.ts";
import {
  ensureUpEntry,
  ensureUpOff,
  stateDir,
  UNIT_PATTERNS,
  writeSupervisorRecord,
  type UnitRecord,
} from "../supervisors.ts";

const RESTART_MS = 5_000;
const BEAT_MS = 30_000;

type UnitName = "discord-gateway" | "duty" | "loop" | "update-check" | "ensure-up";
const UNIT_ORDER: readonly UnitName[] = ["discord-gateway", "duty", "loop", "update-check", "ensure-up"];

type Unit = {
  readonly name: UnitName;
  readonly entry: (home: string, cli: string) => string;
  readonly args: readonly string[];
  readonly log: "gateway" | "loops";
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One supervisor for every long-lived child: the Discord gateway, duty, the hourly loop, update-check and ensure-up.
 * Each child stays a separate process, so an exception in one cannot take the delivery path down with it. Output:
 * `SUPERVISED <event>` lines; one record (state/supervisor.json) and one beat (state/supervisor-heartbeat) every 30 s,
 * plus a gateway-heartbeat compatibility write for the Windows boot guard.
 */
export async function runSupervisor(): Promise<never> {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  const cli = join(import.meta.dir, "..", "cli.ts");
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

  const units = new Map<UnitName, UnitRecord>();
  const list = (): UnitRecord[] => {
    const out: UnitRecord[] = [];
    for (const name of UNIT_ORDER) {
      const unit = units.get(name);
      if (unit !== undefined) out.push(unit);
    }
    return out;
  };
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
  };
  beat();
  setInterval(beat, BEAT_MS).unref();

  const specs: readonly Unit[] = [
    { name: "discord-gateway", entry: (h) => join(h, "bin", "discord-gateway.ts"), args: [], log: "gateway" },
    { name: "duty", entry: () => cli, args: ["duty", "--interval", "60"], log: "loops" },
    { name: "loop", entry: () => cli, args: ["loop"], log: "loops" },
    { name: "update-check", entry: (h) => join(h, "bin", "update-check.ts"), args: [], log: "loops" },
    { name: "ensure-up", entry: (h) => ensureUpEntry(h), args: [], log: "loops" },
  ];

  const runUnit = async (spec: Unit): Promise<never> => {
    for (;;) {
      // ensure-up is deliberately off: keep the unit idle until `dori up` or a person removes the off file.
      if (spec.name === "ensure-up" && ensureUpOff(home)) {
        await sleep(BEAT_MS);
        continue;
      }
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

  log(`SUPERVISED ready units=${specs.map((s) => s.name).join(",")} cli=${cli}`);
  for (const spec of specs) void runUnit(spec);
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

if (import.meta.main) await runSupervisor();
