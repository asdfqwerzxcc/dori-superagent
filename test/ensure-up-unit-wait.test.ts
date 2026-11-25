import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseHome } from "../src/supervise-home.ts";
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

const writeSupervisor = (home: string, pid: number, unitPid: number): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid,
    startedAt: NOW - 60_000,
    units: [{ name: "ensure-up", pid: unitPid, at: NOW - 60_000, pane: "w9:p6" }],
    at: NOW - 60_000,
  });
};

describe("the supervisor-unit wait", () => {
  test("keeps its 10 s unit default when the caller passes no same", async () => {
    const home = homeWithState();
    writeSupervisor(home, SUPERVISOR, UNIT);
    beatAt(home, "supervisor-heartbeat");
    writeEnsureUpRecord(home, { pid: UNIT, startedAt: NOW - 60_000, at: NOW });
    beatAt(home, "ensure-up-heartbeat");
    const alive = new Set([SUPERVISOR, UNIT]);
    const startTimes = new Map<number, number>([[UNIT, NOW - 55_000]]); // registration lags by 5 s
    let now = NOW;
    const state = await superviseHome(home, {
      startMissing: true,
      alive: (pid) => alive.has(pid),
      kill: (pid) => alive.delete(pid),
      started: (pid) => startTimes.get(pid) ?? NOW,
      // No supervisor spawn (the test supplies the record); the missing watchdog spawn returns undefined.
      spawn: () => undefined,
      log: () => {},
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });
    expect(state.ensureUp.alive).toBe(true);
    // The old bug burned the full 10 s before the second cleanup; the 10 s unit predicate finds it at once.
    expect(now).toBe(NOW);
  });
});
