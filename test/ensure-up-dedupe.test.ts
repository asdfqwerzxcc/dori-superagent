import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contenderAlive } from "../src/plugins/plugin.ts";
import { setPluginEnabled, writePluginRecord, writePluginsConfig } from "../src/plugins/state.ts";
import {
  dedupeEnsureUp,
  mergeEnsureUpDedupe,
  supervisorProcessAlive,
  waitEnsureUp,
  waitSupervisorUnit,
} from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;
const SUPERVISOR = 7001;
const UNIT = 7002;
const HOLDER = 7003;
const OTHER = 7004;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-dedupe-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const beatAt = (home: string, name: string, ageMs = 0): void => {
  const path = join(home, "state", name);
  writeFileSync(path, new Date(NOW - ageMs).toISOString());
  utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
};

const writeSupervisor = (home: string, pid: number, unitPid: number): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid,
    startedAt: NOW - 60_000,
    units: [{ name: "ensure-up", pid: unitPid, at: NOW - 60_000, pane: "w9:p6" }],
    at: NOW - 60_000,
  });
};

const writeLock = (home: string, pid: number, startedAt?: number): void => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  writeFileSync(
    join(home, "state", "plugins", "ensure-up.lock"),
    JSON.stringify({ version: 1, pid, at: Date.now(), ...(startedAt === undefined ? {} : { startedAt }) }),
  );
};

type Harness = {
  readonly alive: Set<number>;
  readonly sameCalls: { pid: number; at: number }[];
  readonly startAt: Map<number, number>;
  readonly startTimes: Map<number, number>;
};

const harness = (pids: readonly number[]): Harness => ({
  alive: new Set(pids),
  sameCalls: [],
  startAt: new Map(),
  startTimes: new Map([[UNIT, NOW - 60_000]]),
});

const sameAs =
  (h: Harness) =>
  (child: { pid: number; at: number }): boolean => {
    h.sameCalls.push({ pid: child.pid, at: child.at });
    const started = h.startAt.get(child.pid);
    return h.alive.has(child.pid) && (started === undefined || started === child.at);
  };

const dedupe = (home: string, h: Harness) =>
  dedupeEnsureUp(home, {
    alive: (pid) => h.alive.has(pid),
    kill: (pid) => h.alive.delete(pid),
    same: sameAs(h),
    started: (pid) => h.startTimes.get(pid) ?? NOW,
  });

describe("the active lock holder wins", () => {
  test("an alive idler unit does not displace the process holding the lock", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    writeLock(home, HOLDER, NOW);
    const h = harness([UNIT, HOLDER]);
    expect(await dedupe(home, h)).toEqual({ kept: HOLDER, keptAt: NOW, killed: [] });
    expect([...h.alive].toSorted()).toEqual([UNIT, HOLDER].toSorted());
  });

  test("a duplicate beyond the holder and its standby is still ended", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: OTHER, startedAt: NOW, at: NOW });
    writeLock(home, HOLDER, NOW);
    const h = harness([UNIT, HOLDER, OTHER]);
    expect(await dedupe(home, h)).toEqual({ kept: HOLDER, keptAt: NOW, killed: [OTHER] });
    expect(h.alive.has(UNIT)).toBe(true);
    expect(h.alive.has(HOLDER)).toBe(true);
  });

  test("a disabled plugin leaves no ensure-up process at all", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    writePluginsConfig(home, setPluginEnabled(home, "ensure-up", false));
    const h = harness([UNIT, HOLDER]);
    const result = await dedupe(home, h);
    expect(result).toEqual({ killed: [UNIT, HOLDER] });
    expect(result.kept).toBeUndefined();
    expect([...h.alive]).toEqual([]);
  });
});

describe("stale records, failed kills and fail-closed guards", () => {
  test("a dead unit record does not satisfy the supervisor-unit wait", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, 999_999);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    const h = harness([SUPERVISOR, HOLDER]);
    let now = NOW;
    const found = await waitSupervisorUnit(home, "ensure-up", 1_000, {
      alive: (pid) => h.alive.has(pid),
      same: sameAs(h),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(found).toBe(false);
    expect(await dedupe(home, h)).toEqual({ kept: HOLDER, keptAt: NOW, killed: [] });
  });

  test("a kill that reports success but leaves the pid alive is failed", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    const h = harness([UNIT, HOLDER]);
    let now = NOW;
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: () => true,
      same: sameAs(h),
      started: (pid) => h.startTimes.get(pid) ?? NOW,
      graceMs: 100,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(result).toEqual({ kept: UNIT, keptAt: NOW - 60_000, killed: [], failed: [HOLDER] });
    expect(h.alive.has(HOLDER)).toBe(true);
  });

  test("an unrecorded live lock holder is a candidate: kept while enabled, ended when disabled", async () => {
    const enabledHome = homeWithState();
    writeLock(enabledHome, HOLDER, NOW);
    expect(await dedupe(enabledHome, harness([HOLDER]))).toEqual({ kept: HOLDER, keptAt: NOW, killed: [] });

    const disabledHome = homeWithState();
    writePluginsConfig(disabledHome, setPluginEnabled(disabledHome, "ensure-up", false));
    writeLock(disabledHome, HOLDER, NOW);
    const h = harness([HOLDER]);
    const disabled = await dedupe(disabledHome, h);
    expect(disabled).toEqual({ killed: [HOLDER] });
    expect(h.alive.has(HOLDER)).toBe(false);
  });

  test("the supervisor pid is trusted only with its recorded start time", () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    const h = harness([SUPERVISOR]);
    h.startAt.set(SUPERVISOR, NOW);
    expect(supervisorProcessAlive(home, sameAs(h))).toBe(false);
    h.startAt.set(SUPERVISOR, NOW - 60_000);
    expect(supervisorProcessAlive(home, sameAs(h))).toBe(true);
  });

  test("contenderAlive fails closed when the start time is unreadable or differs", () => {
    const c = { pid: OTHER, at: NOW };
    expect(contenderAlive(c, { alive: () => true, started: () => null })).toBe(false);
    expect(contenderAlive(c, { alive: () => true, started: () => NOW + 60_000 })).toBe(false);
    expect(contenderAlive(c, { alive: () => true, started: () => NOW })).toBe(true);
    expect(contenderAlive(c, { alive: () => false, started: () => NOW })).toBe(false);
  });

  test("a dead first keeper is not carried into the merged verdict", () => {
    const dead = mergeEnsureUpDedupe({ kept: 1, killed: [] }, { killed: [] }, () => false);
    expect(dead).toEqual({ killed: [] });
    expect(dead.kept).toBeUndefined();
    expect(mergeEnsureUpDedupe({ kept: 1, killed: [] }, { killed: [] }, () => true)).toEqual({ kept: 1, killed: [] });
  });

  test("an unreadable start time never authorizes a kill", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    const h = harness([UNIT, HOLDER]);
    let kills = 0;
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: () => {
        kills += 1;
        return true;
      },
      same: sameAs(h),
      started: () => null,
      graceMs: 0,
    });
    expect(kills).toBe(0);
    expect(result.kept).toBe(UNIT);
    expect(result.unverified).toEqual([HOLDER]);
    expect(h.alive.has(HOLDER)).toBe(true);
  });

  test("the freshest non-unit loop is kept when two records disagree", async () => {
    const home = homeWithState();
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW - 60_000, at: NOW - 200_000 });
    writePluginRecord(home, { name: "ensure-up", pid: OTHER, startedAt: NOW - 30_000, at: NOW - 10_000 });
    const h = harness([HOLDER, OTHER]);
    h.startTimes.set(HOLDER, NOW - 60_000);
    h.startTimes.set(OTHER, NOW - 30_000);
    const result = await dedupe(home, h);
    expect(result.kept).toBe(OTHER);
    expect(result.keptAt).toBe(NOW - 30_000);
    expect(result.killed).toEqual([HOLDER]);
  });

  test("the not-wanted health read uses the injected clock and process table", async () => {
    const home = homeWithState();
    writeEnsureUpRecord(home, { pid: 999_999, startedAt: NOW, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const real = await waitEnsureUp(home, false, 0);
    expect(real.alive).toBe(false);
    const injected = await waitEnsureUp(home, false, 0, { alive: () => true, now: () => NOW });
    expect(injected.alive).toBe(true);
  });
});
