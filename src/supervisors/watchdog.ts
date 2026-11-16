import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ageMs,
  ensureUpHealth,
  ensureUpOff,
  entryFor,
  heartbeatPath,
  stateDir,
  STALE_MS,
  WS_HEARTBEAT,
  writeSupervisorRecord,
} from "../supervisors.ts";
import { killSupervisorTree, killTree, listProcesses, matchPids, spawnDetached } from "../supervisor-run.ts";

const CHECK_MS = 20_000;
const GRACE_MS = 90_000;
const ENSURE_UP_STALE_MS = 180_000;

/**
 * The slow safety net under the one supervisor: a stale supervisor heartbeat or Discord socket is killed together
 * with its child command lines and started again. A dead child alone is the supervisor's job, not the watchdog's.
 * Output: `WATCHDOG_*` lines, also appended to state/gateway-watchdog.log.
 */
export async function runWatchdog(): Promise<never> {
  const home = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const state = stateDir(home);
  mkdirSync(state, { recursive: true });
  const logPath = join(state, "gateway-watchdog.log");
  const startedAt = Date.now();
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      appendFileSync(logPath, text);
    } catch {}
    process.stdout.write(text);
  };
  const beat = () => {
    try {
      writeFileSync(join(state, "gateway-watchdog-heartbeat"), new Date().toISOString());
    } catch {}
    writeSupervisorRecord(home, { name: "watchdog", pid: process.pid, startedAt, units: [], at: Date.now() });
  };

  const duplicates = matchPids(await listProcesses(), "gateway-watchdog.ts", "supervisors/watchdog.ts").filter(
    (pid) => pid !== process.pid,
  );
  if (duplicates.length > 0) {
    log(`WATCHDOG_EXIT already_running pids=${duplicates.join(",")}`);
    process.exit(0);
  }

  log(`WATCHDOG_START pid=${process.pid}`);
  beat();
  let graceUntil = Date.now() + GRACE_MS;
  const secs = (ms: number | undefined) =>
    ms === undefined || !Number.isFinite(ms) ? "missing" : `${Math.round(ms / 1000)}s`;

  for (;;) {
    await Bun.sleep(CHECK_MS);
    beat();
    const now = Date.now();
    const supervisorAge = ageMs(heartbeatPath(home, "supervisor"), now);
    const wsAge = ageMs(join(state, WS_HEARTBEAT), now);
    if (now >= graceUntil && ((supervisorAge ?? Infinity) > STALE_MS || (wsAge ?? Infinity) > STALE_MS)) {
      log(`WATCHDOG_STALE supervisor=${secs(supervisorAge)} ws=${secs(wsAge)}`);
      const killed = await killSupervisorTree(await listProcesses());
      log(`WATCHDOG_KILL pids=${killed.join(",") || "-"}`);
      await Bun.sleep(2000);
      const pid = spawnDetached(entryFor(home, "supervisor"), home);
      log(`WATCHDOG_SPAWN supervisor pid=${pid ?? "?"}`);
      graceUntil = Date.now() + GRACE_MS;
    }
    if (!ensureUpOff(home)) {
      const up = ensureUpHealth(home, now);
      if (up.pid !== undefined && (up.heartbeatAgeMs ?? Infinity) > ENSURE_UP_STALE_MS) {
        log(`WATCHDOG_ENSURE_UP_STALE pid=${up.pid} hb=${secs(up.heartbeatAgeMs)}`);
        await killTree(up.pid);
      }
    }
  }
}

if (import.meta.main) await runWatchdog();
