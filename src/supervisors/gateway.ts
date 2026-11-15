import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stateDir, writeSupervisorRecord, type UnitRecord } from "../supervisors.ts";

/** The Discord gateway, restarted whenever it exits. Output: `SUPERVISED <event>` lines, also appended to state/gateway.log. */
export async function runGatewaySupervisor(): Promise<never> {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const gateway = join(home, "bin", "discord-gateway.ts");
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  const log = createWriteStream(join(state, "gateway.log"), { flags: "a" });
  const startedAt = Date.now();
  let units: UnitRecord[] = [];
  const emit = (chunk: Buffer | string) => {
    process.stdout.write(chunk);
    log.write(chunk);
  };
  const write = () =>
    writeSupervisorRecord(home, { name: "gateway", pid: process.pid, startedAt, units, at: Date.now() });
  const beat = () => {
    try {
      writeFileSync(join(state, "gateway-heartbeat"), new Date().toISOString());
    } catch {}
    write();
  };
  beat();
  setInterval(beat, 30_000).unref();

  const once = (restarts: number) =>
    new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [gateway], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, DORI_HOME: home, DORI_VERIFY_PROMPT: "1" },
      });
      if (child.pid !== undefined) {
        units = [{ name: "discord-gateway", pid: child.pid, at: Date.now() }];
        write();
      }
      child.stdout?.on("data", (b: Buffer) => emit(b));
      child.stderr?.on("data", (b: Buffer) => emit(b));
      child.on("exit", (code, signal) => {
        units = [];
        write();
        emit(`SUPERVISED gateway_exit code=${code} signal=${signal} restarts=${restarts + 1}\n`);
        resolve();
      });
    });

  emit(`SUPERVISED ready gateway=${gateway}\n`);
  for (let restarts = 0; ; restarts++) {
    await once(restarts);
    await Bun.sleep(5000);
  }
}

if (import.meta.main) await runGatewaySupervisor();
