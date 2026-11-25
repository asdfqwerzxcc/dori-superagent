import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePluginRecord } from "../src/plugins/state.ts";
import { dedupeEnsureUp, dedupeLine, mergeEnsureUpDedupe, superviseHome } from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";
import { captureIo } from "./inbox-setup.ts";

const NOW = 1_800_000_000_000;
const SUPERVISOR = 7001;
const UNIT = 7002;
const HOLDER = 7003;
const OTHER = 7004;
const CONTENDER = 7005;
const LOOP = 7006;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-race-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
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

const touchAt = (path: string, at: number): void => {
  writeFileSync(path, new Date(at).toISOString());
  utimesSync(path, new Date(at), new Date(at));
};

const writeLock = (home: string, pid: number, startedAt?: number): void => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  writeFileSync(
    join(home, "state", "plugins", "ensure-up.lock"),
    JSON.stringify({ version: 1, pid, at: Date.now(), ...(startedAt === undefined ? {} : { startedAt }) }),
  );
};

const writeContender = (home: string, pid: number, at: number): void => {
  mkdirSync(join(home, "state", "plugins", "ensure-up.contenders"), { recursive: true });
  writeFileSync(join(home, "state", "plugins", "ensure-up.contenders", `${pid}.json`), JSON.stringify({ pid, at }));
};

type Harness = {
  readonly alive: Set<number>;
  readonly startAt: Map<number, number>;
  readonly startTimes: Map<number, number>;
};

const harness = (pids: readonly number[]): Harness => ({
  alive: new Set(pids),
  startAt: new Map(),
  startTimes: new Map([[UNIT, NOW - 60_000]]),
});

const sameAs =
  (h: Harness) =>
  (child: { pid: number; at: number }): boolean => {
    const started = h.startAt.get(child.pid);
    return h.alive.has(child.pid) && (started === undefined || started === child.at);
  };

const dedupe = (home: string, h: Harness, kill?: (pid: number) => boolean) =>
  dedupeEnsureUp(home, {
    alive: (pid) => h.alive.has(pid),
    kill:
      kill ??
      ((pid) => {
        h.alive.delete(pid);
        return true;
      }),
    same: sameAs(h),
    started: (pid) => h.startTimes.get(pid) ?? NOW,
  });

describe("a lock takeover during the cleanup", () => {
  test("a candidate elected mid-pass is kept and never killed", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: OTHER, startedAt: NOW, at: NOW });
    writeContender(home, CONTENDER, NOW);
    writeLock(home, HOLDER, NOW);
    const h = harness([UNIT, HOLDER, OTHER, CONTENDER]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        if (pid === OTHER) writeLock(home, CONTENDER, NOW);
        return true;
      },
      same: sameAs(h),
      started: (pid) => h.startTimes.get(pid) ?? NOW,
    });
    expect(result.killed).toEqual([OTHER, HOLDER]);
    expect(h.alive.has(HOLDER)).toBe(false);
    expect(result.kept).toBe(CONTENDER);
    expect(result.keptAt).toBe(NOW);
    expect(h.alive.has(CONTENDER)).toBe(true);
  });

  test("a second pass after the cleanup kills nothing", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    const h = harness([UNIT, HOLDER]);
    expect(await dedupe(home, h)).toEqual({ kept: UNIT, keptAt: NOW - 60_000, killed: [HOLDER] });
    expect(await dedupe(home, h)).toEqual({ kept: UNIT, keptAt: NOW - 60_000, killed: [] });
  });

  test("a failed kill that is now the holder is kept, not failed", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: OTHER, startedAt: NOW, at: NOW });
    const h = harness([UNIT, HOLDER, OTHER]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        if (pid === OTHER) {
          writeLock(home, OTHER, NOW);
          return false;
        }
        h.alive.delete(pid);
        return true;
      },
      same: sameAs(h),
      started: (pid) => h.startTimes.get(pid) ?? NOW,
      graceMs: 0,
    });
    expect(result.kept).toBe(OTHER);
    expect(result.keptAt).toBe(NOW);
    expect(result.failed).toBeUndefined();
  });

  test("a started supervisor does not displace a pane loop that holds the lock", async () => {
    const home = homeWithState();
    writeEnsureUpRecord(home, { pid: LOOP, startedAt: NOW - 60_000, at: NOW });
    touchAt(join(home, "state", "ensure-up-heartbeat"), NOW);
    writeLock(home, LOOP, NOW);
    const h = harness([LOOP]);
    const spawned: (readonly string[])[] = [];
    let now = NOW;
    const state = await superviseHome(home, {
      startMissing: true,
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      same: sameAs(h),
      spawn: (entry, _cwd, args = []) => {
        spawned.push(args);
        if (entry.endsWith("supervisor.ts")) {
          writeSupervisor(home, SUPERVISOR, UNIT);
          touchAt(join(home, "state", "supervisor-heartbeat"), NOW);
          h.alive.add(SUPERVISOR);
          h.alive.add(UNIT);
        }
        return 9_999;
      },
      started: (pid) => h.startTimes.get(pid) ?? NOW,
      log: () => {},
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(spawned.filter((args) => args.includes("ensure-up"))).toEqual([]);
    expect(h.alive.has(LOOP)).toBe(true);
    expect(h.alive.has(UNIT)).toBe(true);
    expect(state.ensureUp.alive).toBe(true);
  });

  test("a first-pass failure that becomes the second keeper is not failed", () => {
    const merged = mergeEnsureUpDedupe(
      { kept: UNIT, keptAt: NOW, killed: [], failed: [OTHER] },
      { kept: OTHER, keptAt: NOW - 30_000, killed: [] },
      () => true,
      () => true,
    );
    expect(merged.kept).toBe(OTHER);
    expect(merged.failed).toBeUndefined();
  });

  test("a failed or unverified pid is printed once", () => {
    expect(dedupeLine({ kept: 1, killed: [2], failed: [3] })).toBe("ENSURE_UP dedupe kept=1 killed=2 failed=3");
    expect(dedupeLine({ killed: [], failed: [3] })).toBe("ENSURE_UP dedupe kept=none failed=3");
    expect(dedupeLine({ killed: [], unverified: [4] })).toBe("ENSURE_UP dedupe kept=none unverified=4");
  });

  test("a lock whose live pid has a different start time is not held", async () => {
    const home = homeWithState();
    writeLock(home, HOLDER, NOW);
    const h = harness([HOLDER]);
    h.startAt.set(HOLDER, NOW - 60_000);
    const result = await dedupe(home, h);
    expect(result).toEqual({ killed: [], unverified: [HOLDER] });
    expect(result.kept).toBeUndefined();
  });

  test("a first-pass failure that died before the second pass is not carried", () => {
    const merged = mergeEnsureUpDedupe(
      { killed: [], failed: [12] },
      { killed: [] },
      () => false,
      () => true,
    );
    expect(merged).toEqual({ killed: [] });
    expect(merged.failed).toBeUndefined();
    expect(
      mergeEnsureUpDedupe(
        { killed: [], failed: [12] },
        { killed: [] },
        () => true,
        () => true,
      ).failed,
    ).toEqual([12]);
  });

  test("the library logger is silent by default", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: HOLDER, startedAt: NOW, at: NOW });
    const h = harness([SUPERVISOR, UNIT, HOLDER]);
    let now = NOW;
    const capture = await captureIo(async () => {
      await superviseHome(home, {
        startMissing: false,
        alive: (pid) => h.alive.has(pid),
        kill: (pid) => h.alive.delete(pid),
        same: sameAs(h),
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      });
      return 0;
    });
    expect(capture.out).not.toContain("ENSURE_UP dedupe");
  });
});
