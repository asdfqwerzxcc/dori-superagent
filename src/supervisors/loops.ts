import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensureUpEntry,
  ensureUpHealth,
  ensureUpOff,
  stateDir,
  writeSupervisorRecord,
  type UnitRecord,
} from "../supervisors.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Duty (`dori duty --interval 60`), the hourly `dori loop`, update-check and the ensure-up loop, each kept alive with a
 * bounded backoff. Output: `SUPERVISED <event>` lines appended to state/loops.log; state/loops-heartbeat every 30 s.
 */
export async function runLoopsSupervisor(): Promise<never> {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  const log = createWriteStream(join(state, "loops.log"), { flags: "a" });
  const cli = join(import.meta.dir, "..", "cli.ts");
  const startedAt = Date.now();
  let units: UnitRecord[] = [];

  const emit = (line: string) => log.write(line);
  const stamp = () => new Date().toISOString().slice(11, 19);
  const write = () =>
    writeSupervisorRecord(home, { name: "loops", pid: process.pid, startedAt, units, at: Date.now() });
  const beat = () => {
    try {
      writeFileSync(join(state, "loops-heartbeat"), new Date().toISOString());
    } catch {}
    write();
  };
  beat();
  setInterval(beat, 30_000).unref();

  const supervised = (name: string, args: string[], entry: string) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: home,
      windowsHide: true,
      env: { ...process.env, DORI_HOME: home, DORI_VERIFY_PROMPT: "1" },
    });
    const pid = child.pid;
    if (pid !== undefined) {
      units = [...units.filter((u) => u.name !== name), { name, pid, at: Date.now() }];
      write();
    }
    child.stdout?.on("data", (b: Buffer) => emit(b.toString()));
    child.stderr?.on("data", (b: Buffer) => emit(b.toString()));
    return new Promise<number | null>((resolve) => {
      child.on("exit", (code) => {
        units = units.filter((u) => u.name !== name);
        write();
        emit(`${stamp()} SUPERVISED ${name}_exit code=${code}\n`);
        resolve(code);
      });
      child.on("error", () => {
        units = units.filter((u) => u.name !== name);
        write();
        resolve(null);
      });
    });
  };

  const keep = async (name: string, args: string[], entry: string, wanted: () => boolean = () => true) => {
    let failures = 0;
    for (;;) {
      if (!wanted()) {
        await sleep(30_000);
        continue;
      }
      const started = Date.now();
      await supervised(name, args, entry);
      const ranFor = Date.now() - started;
      failures = ranFor > 60_000 ? 0 : failures + 1;
      const delay = failures === 0 ? 5000 : Math.min(5000 * 2 ** (failures - 1), 300_000);
      emit(
        `${stamp()} SUPERVISED ${name}_restart n=${failures} ran=${Math.round(ranFor / 1000)}s wait=${Math.round(delay / 1000)}s\n`,
      );
      if (failures === 5)
        spawn(
          process.execPath,
          [cli, "send", "lead", "--text", `[SUPERVISOR] ${name} keeps failing; backing off to 5min between attempts.`],
          { stdio: "ignore", windowsHide: true },
        ).unref();
      await sleep(delay);
    }
  };

  const wantsEnsureUp = () => !ensureUpOff(home) && !ensureUpHealth(home).alive;
  emit(`${stamp()} SUPERVISED ready duty+loop+update-check+ensure-up cli=${cli}\n`);
  await Promise.all([
    keep("duty", ["duty", "--interval", "60"], cli),
    keep("loop", ["loop"], cli),
    keep("update-check", [], join(home, "bin", "update-check.ts")),
    keep("ensure-up", [], ensureUpEntry(home), wantsEnsureUp),
  ]);
  throw new Error("unreachable");
}

if (import.meta.main) await runLoopsSupervisor();
