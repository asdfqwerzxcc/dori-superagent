import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeEnsureUp, superviseHome, waitSupervisorUnit } from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;
const SUPERVISOR = 7001;
const UNIT = 7002;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-unit-wait-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

/** Writes a heartbeat whose age the fake clock sees, so a stale supervisor needs no wait. */
const beatAt = (home: string, name: string, ageMs = 0): void => {
  const path = join(home, "state", name);
  writeFileSync(path, new Date(NOW - ageMs).toISOString());
  utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs));
};

const writeSupervisor = (home: string, unitStartedAt?: number): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid: SUPERVISOR,
    startedAt: NOW - 60_000,
    units: [
      {
        name: "ensure-up",
        pid: UNIT,
        at: NOW - 60_000,
        ...(unitStartedAt === undefined ? {} : { startedAt: unitStartedAt }),
        pane: "w9:p6",
      },
    ],
    at: NOW - 60_000,
  });
};

describe("the supervisor-unit wait", () => {
  test("a matching unit start satisfies the wait without a delay", async () => {
    const home = homeWithState();
    writeSupervisor(home);
    const found = await waitSupervisorUnit(home, "ensure-up", 1_000, {
      alive: (pid) => pid === SUPERVISOR || pid === UNIT,
      started: () => NOW - 60_000,
      now: () => NOW,
      sleep: async () => {},
    });
    expect(found).toBe(true);
  });

  test("a 5 s lag is refused by the unit wait and by the kill", async () => {
    const home = homeWithState();
    writeSupervisor(home);
    beatAt(home, "supervisor-heartbeat");
    writeEnsureUpRecord(home, { pid: UNIT, startedAt: NOW - 60_000, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const alive = new Set([SUPERVISOR, UNIT]);
    const started = (): number => NOW - 55_000;
    let now = NOW;
    const found = await waitSupervisorUnit(home, "ensure-up", 1_000, {
      alive: (pid) => alive.has(pid),
      started,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(found).toBe(false);
    expect(now).toBe(NOW + 1_000);

    const result = await dedupeEnsureUp(home, {
      alive: (pid) => alive.has(pid),
      kill: (pid) => alive.delete(pid),
      started,
      now: () => NOW,
    });
    expect(result.kept).toBeUndefined();
    expect(result.killed).toEqual([]);
    expect(result.unverified).toEqual([UNIT]);
  });

  test("superviseHome's unit wait burns its budget on the same 5 s lag", async () => {
    const home = homeWithState();
    writeSupervisor(home);
    beatAt(home, "supervisor-heartbeat");
    writeEnsureUpRecord(home, { pid: UNIT, startedAt: NOW - 60_000, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const alive = new Set([SUPERVISOR, UNIT]);
    let now = NOW;
    const state = await superviseHome(home, {
      startMissing: true,
      alive: (pid) => alive.has(pid),
      kill: (pid) => alive.delete(pid),
      started: () => NOW - 55_000,
      spawn: () => undefined,
      log: () => {},
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(state.ensureUp.alive).toBe(true);
    expect(now).toBe(NOW + 10_000);
  });
});
