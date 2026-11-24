import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquirePidLock } from "../pid-lock.ts";
import { startedNear } from "../process-liveness.ts";
import {
  ageMs,
  ensureUpHealth,
  ensureUpOff,
  entryFor,
  heartbeatPath,
  stateDir,
  STALE_MS,
  supervisorRecord,
  WS_HEARTBEAT,
  writeSupervisorRecord,
} from "../supervisors.ts";
import { killSupervisorTree, killTree, spawnDetached } from "../supervisor-run.ts";

const CHECK_MS = 20_000;
const GRACE_MS = 90_000;
const ENSURE_UP_STALE_MS = 180_000;
/** A stale socket alone gets the gateway child this many times before the watchdog takes the whole stack. */
const GATEWAY_ATTEMPTS = 2;

export type WatchdogAction =
  | { readonly kind: "none" }
  | { readonly kind: "gateway"; readonly pids: readonly number[] }
  | { readonly kind: "supervisor" };

/**
 * A stale Discord socket under a fresh supervisor is the gateway's own failure: its unit loop replaces a killed child
 * in place, so the stack and its panes stay put. Only a stale supervisor heartbeat, a missing gateway pid, or a socket
 * still stale after two child restarts takes the whole tree down.
 */
export function staleAction(o: {
  readonly supervisorAgeMs?: number | undefined;
  readonly wsAgeMs?: number | undefined;
  readonly gatewayPids: readonly number[];
  readonly gatewayAttempts: number;
}): WatchdogAction {
  const stale = (age: number | undefined) => (age ?? Infinity) > STALE_MS;
  if (!stale(o.supervisorAgeMs) && !stale(o.wsAgeMs)) return { kind: "none" };
  if (!stale(o.supervisorAgeMs) && o.gatewayPids.length > 0 && o.gatewayAttempts < GATEWAY_ATTEMPTS)
    return { kind: "gateway", pids: o.gatewayPids };
  return { kind: "supervisor" };
}

/**
 * The slow safety net under the one supervisor: a stale supervisor heartbeat takes the whole tree down and starts it
 * again; a stale Discord socket alone costs only the gateway child. A dead child alone is the supervisor's job, not the
 * watchdog's. Output: `WATCHDOG_*` lines, also appended to state/gateway-watchdog.log.
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

  if (!acquirePidLock(join(state, "watchdog.lock"))) {
    log("WATCHDOG_EXIT already_running lock=1");
    process.exit(0);
  }
  const previous = supervisorRecord(home, "watchdog");
  if (previous !== undefined && previous.pid !== process.pid && startedNear(previous.pid, previous.startedAt)) {
    log(`WATCHDOG_EXIT already_running pids=${previous.pid}`);
    process.exit(0);
  }

  log(`WATCHDOG_START pid=${process.pid}`);
  beat();
  let graceUntil = Date.now() + GRACE_MS;
  const secs = (ms: number | undefined) =>
    ms === undefined || !Number.isFinite(ms) ? "missing" : `${Math.round(ms / 1000)}s`;

  let gatewayAttempts = 0;
  for (;;) {
    await Bun.sleep(CHECK_MS);
    beat();
    const now = Date.now();
    const supervisorAge = ageMs(heartbeatPath(home, "supervisor"), now);
    const wsAge = ageMs(join(state, WS_HEARTBEAT), now);
    const wsStale = (wsAge ?? Infinity) > STALE_MS;
    if (!wsStale) gatewayAttempts = 0;
    if (now >= graceUntil && (wsStale || (supervisorAge ?? Infinity) > STALE_MS)) {
      // The supervisor record names its gateway child; a live start time proves the pid is still that child.
      const gatewayPids = (supervisorRecord(home, "supervisor")?.units ?? [])
        .filter((u) => u.name === "discord-gateway" && startedNear(u.pid, u.at))
        .map((u) => u.pid);
      const action = staleAction({
        supervisorAgeMs: supervisorAge,
        wsAgeMs: wsAge,
        gatewayPids,
        gatewayAttempts,
      });
      if (action.kind === "gateway") {
        log(`WATCHDOG_GATEWAY_STALE ws=${secs(wsAge)} pids=${action.pids.join(",")}`);
        for (const pid of action.pids) await killTree(pid);
        gatewayAttempts++;
        graceUntil = Date.now() + GRACE_MS;
      } else if (action.kind === "supervisor") {
        gatewayAttempts = 0;
        log(`WATCHDOG_STALE supervisor=${secs(supervisorAge)} ws=${secs(wsAge)}`);
        const killed = await killSupervisorTree(home);
        log(`WATCHDOG_KILL pids=${killed.join(",") || "-"}`);
        await Bun.sleep(2000);
        const pid = spawnDetached(entryFor(home, "supervisor"), home);
        log(`WATCHDOG_SPAWN supervisor pid=${pid ?? "?"}`);
        graceUntil = Date.now() + GRACE_MS;
      }
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
