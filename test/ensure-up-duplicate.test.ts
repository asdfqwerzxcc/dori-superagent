import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePluginRecord } from "../src/plugins/state.ts";
import { dedupeEnsureUp, superviseHome } from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;
const SUPERVISOR = 7001;
const UNIT = 7002;
const LOOP = 7003;
const CONTENDER = 7004;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-dup-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const contenderFile = (home: string, pid: number): string =>
  join(home, "state", "plugins", "ensure-up.contenders", `${pid}.json`);

const writeContender = (home: string, pid: number, at: number): void => {
  mkdirSync(join(home, "state", "plugins", "ensure-up.contenders"), { recursive: true });
  writeFileSync(contenderFile(home, pid), JSON.stringify({ pid, at }));
};

/** Writes a heartbeat whose age the fake clock sees, so a stale supervisor needs no wait. */
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

type Harness = {
  readonly alive: Set<number>;
  readonly spawned: (readonly string[])[];
  readonly logs: string[];
  readonly sameCalls: { pid: number; at: number }[];
  readonly startedCalls: number[];
  readonly startAt: Map<number, number>;
  readonly startTimes: Map<number, number>;
};

const harness = (pids: readonly number[]): Harness => ({
  alive: new Set(pids),
  spawned: [],
  logs: [],
  sameCalls: [],
  startedCalls: [],
  startAt: new Map(),
  startTimes: new Map([
    [SUPERVISOR, NOW - 60_000],
    [UNIT, NOW - 60_000],
  ]),
});

/** Every same call is recorded; a pid with a fake OS start time must match the record's at exactly. */
const sameAs =
  (h: Harness) =>
  (child: { pid: number; at: number }): boolean => {
    h.sameCalls.push({ pid: child.pid, at: child.at });
    const started = h.startAt.get(child.pid);
    return h.alive.has(child.pid) && (started === undefined || started === child.at);
  };

/** Runs superviseHome on a fake clock and a fake process table, recording every spawn, log line and same call. */
const run = async (
  home: string,
  h: Harness,
  startMissing = false,
  spawn?: (entry: string, cwd: string, args?: readonly string[]) => number | undefined,
) => {
  let now = NOW;
  return superviseHome(home, {
    startMissing,
    alive: (pid) => h.alive.has(pid),
    kill: (pid) => h.alive.delete(pid),
    same: sameAs(h),
    started: (pid) => {
      h.startedCalls.push(pid);
      return h.startTimes.get(pid) ?? NOW;
    },
    spawn:
      spawn ??
      ((_entry, _cwd, args) => {
        h.spawned.push(args ?? []);
        return 9_999;
      }),
    log: (line) => h.logs.push(line),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  });
};

describe("superviseHome owns ensure-up", () => {
  test("supervisor up + ensure-up up: no spawn, both pids guarded by their start time", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    beatAt(home, "supervisor-heartbeat");
    writeEnsureUpRecord(home, { pid: UNIT, startedAt: NOW - 60_000, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const h = harness([SUPERVISOR, UNIT]);
    const state = await run(home, h);
    expect(h.spawned).toEqual([]);
    expect(state.ensureUp).toMatchObject({ pid: UNIT, alive: true });
    expect(h.startedCalls).toContain(SUPERVISOR);
    expect(h.sameCalls).toContainEqual({ pid: UNIT, at: NOW - 60_000 });
  });

  test("a supervisor whose beat is late still owns ensure-up: no second loop", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    beatAt(home, "supervisor-heartbeat", 200_000);
    writeEnsureUpRecord(home, { pid: UNIT, startedAt: NOW - 60_000, at: NOW - 200_000 });
    beatAt(home, "ensure-up-heartbeat", 200_000);
    const h = harness([SUPERVISOR, UNIT]);
    const state = await run(home, h);
    expect(h.spawned).toEqual([]);
    expect(state.ensureUp.alive).toBe(false);
  });

  test("startMissing asks for the supervisor, never for a second ensure-up", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    beatAt(home, "supervisor-heartbeat", 200_000);
    const h = harness([SUPERVISOR]);
    await run(home, h, true);
    expect(h.spawned.filter((args) => args.includes("ensure-up"))).toEqual([]);
  });

  test("a late-beat supervisor with no ensure-up starts nothing", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    beatAt(home, "supervisor-heartbeat", 200_000);
    const h = harness([SUPERVISOR]);
    await run(home, h);
    expect(h.spawned).toEqual([]);
  });

  test("pane mode keeps a live loop on a late beat instead of starting a standby", async () => {
    const home = homeWithState();
    writeEnsureUpRecord(home, { pid: LOOP, startedAt: NOW - 60_000, at: NOW - 200_000 });
    beatAt(home, "ensure-up-heartbeat", 200_000);
    const h = harness([LOOP]);
    await run(home, h);
    expect(h.spawned).toEqual([]);
    expect(h.logs.filter((line) => line.includes("ENSURE_UP dedupe"))).toEqual([]);
  });

  test("a supervisor started now takes the pane loop's place before the line is printed", async () => {
    const home = homeWithState();
    writeEnsureUpRecord(home, { pid: LOOP, startedAt: NOW - 60_000, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const h = harness([LOOP]);
    h.startTimes.set(LOOP, NOW - 60_000);
    const spawn = (entry: string, _cwd: string, args: readonly string[] = []): number | undefined => {
      h.spawned.push(args);
      if (entry.endsWith("supervisor.ts")) {
        writeSupervisor(home, SUPERVISOR, UNIT);
        beatAt(home, "supervisor-heartbeat");
        h.alive.add(SUPERVISOR);
        h.alive.add(UNIT);
      }
      return 9_999;
    };
    await run(home, h, true, spawn);
    expect(h.logs.filter((line) => line.includes("ENSURE_UP dedupe"))).toEqual([
      `ENSURE_UP dedupe kept=${UNIT} killed=${LOOP}`,
    ]);
    expect(h.spawned.filter((args) => args.includes("ensure-up"))).toEqual([]);
  });
});

describe("dedupeEnsureUp keeps one loop", () => {
  const dedupe = (home: string, h: Harness) =>
    dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => h.alive.delete(pid),
      same: sameAs(h),
      started: (pid) => h.startTimes.get(pid) ?? NOW,
    });

  test("the supervisor's unit wins over the loop that beats last; the other is terminated", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: LOOP, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: CONTENDER, startedAt: NOW, at: NOW });
    const h = harness([UNIT, LOOP, CONTENDER]);
    const result = await dedupe(home, h);
    expect(result.kept).toBe(UNIT);
    expect([...result.killed].sort()).toEqual([LOOP, CONTENDER].sort());
  });

  test("a kill that does not take stays visible as failed and keeps its contender marker", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeContender(home, CONTENDER, NOW);
    const h = harness([UNIT, CONTENDER]);
    h.startTimes.set(CONTENDER, NOW);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: () => true,
      same: sameAs(h),
      started: (pid) => h.startTimes.get(pid) ?? NOW,
      graceMs: 0,
    });
    expect(result.kept).toBe(UNIT);
    expect(result.failed).toEqual([CONTENDER]);
    expect(existsSync(contenderFile(home, CONTENDER))).toBe(true);
  });

  test("a live pid whose start time does not match is not trusted as a contender", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeContender(home, CONTENDER, NOW);
    const h = harness([UNIT, CONTENDER]);
    h.startTimes.set(CONTENDER, NOW + 60_000);
    const result = await dedupe(home, h);
    expect(result.kept).toBe(UNIT);
    expect(result.killed).toEqual([]);
    expect(result.unverified).toEqual([CONTENDER]);
  });

  test("dori up reports the cleanup in one line and starts nothing while the supervisor lives", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    writeEnsureUpRecord(home, { pid: LOOP, startedAt: NOW, at: NOW });
    const h = harness([SUPERVISOR, UNIT, LOOP]);
    await run(home, h);
    expect(h.logs).toContain(`ENSURE_UP dedupe kept=${UNIT} killed=${LOOP}`);
    expect(h.spawned).toEqual([]);
  });
});
