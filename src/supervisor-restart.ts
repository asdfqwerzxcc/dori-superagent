import { join } from "node:path";
import { enabledPluginNames, isPluginEnabled } from "./plugins/state.ts";
import { pidAlive } from "./process-liveness.ts";
import { ensureSupervisors, killSupervisorTree, waitEnsureUp, waitFresh } from "./supervisor-run.ts";
import {
  ageMs,
  CORE_UNITS,
  ensureUpOff,
  formatEnsureUp,
  formatSupervised,
  heartbeatPath,
  restartMissing,
  stateDir,
  supervisorHealth,
  WS_HEARTBEAT,
  type EnsureUpHealth,
  type SupervisorHealth,
} from "./supervisors.ts";
import { formatUnitPlacement, printable } from "./unit-placement.ts";

export type RestartResult = {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly killed: readonly number[];
  readonly health: readonly SupervisorHealth[];
  /** The units this home runs (core plus enabled plugins), so the caller can name every headless one. */
  readonly expected: readonly string[];
  readonly ensureUp: EnsureUpHealth;
  readonly wsHeartbeatAgeMs?: number;
  readonly off: boolean;
  readonly retried: boolean;
  readonly missing: readonly string[];
};

/**
 * What `dori restart` prints, in order: each supervisor's line, the unit placement line, ensure-up, every missing piece,
 * then the verdict. Exported so the printed line itself is tested, not only the pieces it is built from.
 */
export function restartLines(r: RestartResult, units: "panes" | "headless"): string[] {
  const ws = r.wsHeartbeatAgeMs === undefined ? "missing" : `${Math.round(r.wsHeartbeatAgeMs / 1000)}s`;
  const retried = r.retried ? " retried=1" : "";
  const verdict = `${r.ok ? "RESTARTED" : "RESTART INCOMPLETE"} killed=${r.killed.length} ms=${r.elapsedMs} ws=${ws}${retried} units=${units}`;
  return [
    ...formatSupervised(r.health),
    formatUnitPlacement(r.health, r.expected),
    formatEnsureUp(r.ensureUp, r.off),
    ...r.missing.map((part) => `RESTART MISSING ${printable(part)}`),
    verdict,
  ];
}

/** What a restart needs from outside; tests replace it to drive a partial failure and its retry without real processes. */
type RestartIo = {
  readonly kill: () => Promise<readonly number[]>;
  readonly ensure: (home: string, waitMs: number) => Promise<readonly SupervisorHealth[]>;
  readonly health: (home: string) => readonly SupervisorHealth[];
  readonly waitFresh: (paths: readonly string[], since: number, waitMs: number) => Promise<boolean>;
  readonly waitEnsureUp: (home: string, wanted: boolean, waitMs: number) => Promise<EnsureUpHealth>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
};

/**
 * One command for the supervised half of the stack: kills the recorded supervisor tree and any orphaned unit, starts
 * one supervisor again, and waits until the supervisor heartbeat, the Discord socket heartbeat (`gateway-ws-heartbeat`)
 * and all units are up and newer than the moment the restart began. A failed attempt is retried once, and the second
 * verdict names every piece that is still missing and why.
 */
export async function restartSupervisors(
  home: string,
  opts: { readonly timeoutMs?: number; readonly io?: Partial<RestartIo> } = {},
): Promise<RestartResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const io: RestartIo = {
    kill: () => killSupervisorTree(home),
    ensure: ensureSupervisors,
    health: supervisorHealth,
    waitFresh: (paths, since, waitMs) => waitFresh(paths, since, { timeoutMs: waitMs }),
    waitEnsureUp,
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
    ...opts.io,
  };
  const started = io.now();
  const killed = await io.kill(); // A replacement must not start while an old tree lives, or it exits as a duplicate.
  for (let i = 0; i < 40 && killed.some(pidAlive); i++) await io.sleep(250);
  const expected = [...CORE_UNITS, ...enabledPluginNames(home)];
  const wanted = !ensureUpOff(home) && isPluginEnabled(home, "ensure-up");
  const beats = [heartbeatPath(home, "supervisor"), join(stateDir(home), WS_HEARTBEAT)];
  const settle = async () => {
    const fresh = await io.waitFresh(beats, started, timeoutMs);
    const ensureUp = await io.waitEnsureUp(home, wanted, fresh ? 15_000 : 0);
    const deadline = io.now() + timeoutMs;
    let health = io.health(home);
    const unitsUp = (h: readonly SupervisorHealth[]): boolean => {
      const units = h.find((s) => s.name === "supervisor")?.units ?? [];
      return expected.every((name) => units.some((u) => u.name === name && u.alive));
    };
    // Units started through panes register a moment after the supervisor's own heartbeat, so poll instead of reading once.
    while (!unitsUp(health) && io.now() < deadline) {
      await io.sleep(500);
      health = io.health(home);
    }
    const supervisor = health.find((h) => h.name === "supervisor");
    const ok = fresh && supervisor?.alive === true && unitsUp(health) && (!wanted || ensureUp.alive);
    return { health, ensureUp, ok };
  };
  await io.ensure(home, timeoutMs);
  let attempt = await settle();
  const retried = !attempt.ok;
  if (retried) {
    await io.ensure(home, timeoutMs);
    attempt = await settle();
  }
  const now = io.now();
  const wsAge = ageMs(beats[1]!, now);
  return {
    ok: attempt.ok,
    elapsedMs: now - started,
    killed,
    health: attempt.health,
    expected,
    ensureUp: attempt.ensureUp,
    ...(wsAge !== undefined ? { wsHeartbeatAgeMs: wsAge } : {}),
    off: !wanted,
    retried,
    missing: attempt.ok
      ? []
      : restartMissing({
          home,
          since: started,
          expected,
          wanted,
          health: attempt.health,
          ensureUp: attempt.ensureUp,
          now,
        }),
  };
}
