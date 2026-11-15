import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ageMs,
  ensureUpHealth,
  ensureUpOff,
  entryFor,
  heartbeatPath,
  LOOPS_STALE_MS,
  stateDir,
  STALE_MS,
  WS_HEARTBEAT,
  writeSupervisorRecord,
} from "../supervisors.ts";
import { killTree, listProcesses, matchPids, spawnDetached } from "../supervisor-run.ts";

const CHECK_MS = 20_000;
const GRACE_MS = 90_000;
const ENSURE_UP_STALE_MS = 180_000;

/**
 * The slow safety net under the supervisors: a gateway whose heartbeat or Discord socket went stale is killed and
 * restarted, and so is a loops supervisor that stopped beating. Each check has its own grace window, so a restarting
 * gateway never suppresses the loops check. Output: `WATCHDOG_*` lines, also appended to state/gateway-watchdog.log.
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
  let gatewayGraceUntil = Date.now() + GRACE_MS;
  let loopsGraceUntil = Date.now() + GRACE_MS;
  const secs = (ms: number | undefined) =>
    ms === undefined || !Number.isFinite(ms) ? "missing" : `${Math.round(ms / 1000)}s`;

  for (;;) {
    await Bun.sleep(CHECK_MS);
    beat();
    const procs = await listProcesses();
    const now = Date.now();

    const gatewayAge = ageMs(heartbeatPath(home, "gateway"), now);
    const wsAge = ageMs(join(state, WS_HEARTBEAT), now);
    if (now >= gatewayGraceUntil && ((gatewayAge ?? Infinity) > STALE_MS || (wsAge ?? Infinity) > STALE_MS)) {
      log(`WATCHDOG_STALE supervisor=${secs(gatewayAge)} ws=${secs(wsAge)}`);
      for (const pid of matchPids(procs, "gateway-supervisor.ts", "supervisors/gateway.ts", "discord-gateway.ts"))
        await killTree(pid);
      await Bun.sleep(2000);
      const pid = spawnDetached(entryFor(home, "gateway"), home);
      log(`WATCHDOG_SPAWN supervisor pid=${pid ?? "?"}`);
      gatewayGraceUntil = Date.now() + GRACE_MS;
    }

    const loopsAge = ageMs(heartbeatPath(home, "loops"), now);
    if (now >= loopsGraceUntil && (loopsAge ?? Infinity) > LOOPS_STALE_MS) {
      log(`WATCHDOG_LOOPS_STALE age=${secs(loopsAge)}`);
      for (const pid of matchPids(procs, "loops-supervisor.ts", "supervisors/loops.ts")) await killTree(pid);
      await Bun.sleep(2000);
      const pid = spawnDetached(entryFor(home, "loops"), home);
      log(`WATCHDOG_SPAWN loops pid=${pid ?? "?"}`);
      loopsGraceUntil = Date.now() + GRACE_MS;
    }
    if (!ensureUpOff(home)) {
      const up = ensureUpHealth(home, Date.now());
      if (up.pid !== undefined && (up.heartbeatAgeMs ?? Infinity) > ENSURE_UP_STALE_MS) {
        log(`WATCHDOG_ENSURE_UP_STALE pid=${up.pid} hb=${secs(up.heartbeatAgeMs)}`);
        await killTree(up.pid);
      }
    }
  }
}

if (import.meta.main) await runWatchdog();
