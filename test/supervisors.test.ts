import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureUpHealth,
  formatEnsureUp,
  formatSupervised,
  formatSupervisor,
  supervisorHealth,
} from "../src/supervisors.ts";
import { matchPids, parseCim, parsePs } from "../src/supervisor-run.ts";
import { FIVE_UNITS, NOW, beat, homeWithState, supervisorRecord, watchdogRecord } from "./supervisor-fixtures.ts";

describe("supervisor records and heartbeats", () => {
  test("a fresh beat plus the recorded pid is up, with each unit's liveness beside it", () => {
    const home = homeWithState();
    beat(home, "supervisor-heartbeat");
    supervisorRecord(home);
    const [supervisor, watchdog] = supervisorHealth(home, NOW);
    expect(watchdog).toMatchObject({ name: "watchdog", alive: false, units: [] });
    expect(supervisor).toMatchObject({ name: "supervisor", pid: process.pid, alive: true, heartbeatAgeMs: 0 });
    expect(supervisor?.units.map((u) => u.name)).toEqual([...FIVE_UNITS]);
    expect(supervisor?.units.every((u) => u.alive)).toBe(true);
    expect(formatSupervisor(supervisor!)).toBe(
      `SUPERVISED supervisor up pid=${process.pid} hb=0s units=${FIVE_UNITS.map((u) => `${u}:${process.pid}`).join(",")}`,
    );
  });

  test("a stale beat or a dead recorded pid is DOWN, and a dead unit says so", () => {
    const home = homeWithState();
    beat(home, "supervisor-heartbeat", NOW - 300_000);
    supervisorRecord(home);
    expect(supervisorHealth(home, NOW)[0]).toMatchObject({ name: "supervisor", alive: false, heartbeatAgeMs: 300_000 });

    beat(home, "supervisor-heartbeat");
    const dead = supervisorHealth(home, NOW, () => false)[0];
    expect(dead).toMatchObject({ name: "supervisor", alive: false });
    expect(formatSupervisor(dead!)).toContain("(dead)");
  });

  test("old per-half heartbeats no longer make a supervisor, and the watchdog prints separately", () => {
    const home = homeWithState();
    beat(home, "loops-heartbeat");
    beat(home, "gateway-heartbeat");
    expect(supervisorHealth(home, NOW)[0]).toMatchObject({ name: "supervisor", alive: false, units: [] });

    beat(home, "gateway-watchdog-heartbeat");
    watchdogRecord(home);
    expect(formatSupervised(supervisorHealth(home, NOW))[1]).toBe(`WATCHDOG up pid=${process.pid} hb=0s`);
  });

  test("ensure-up has its own record and beat; the off file is reported separately", () => {
    const home = homeWithState();
    beat(home, "ensure-up-heartbeat");
    writeFileSync(join(home, "state", "ensure-up.json"), JSON.stringify({ pid: process.pid, startedAt: NOW, at: NOW }));
    expect(ensureUpHealth(home, NOW)).toMatchObject({ pid: process.pid, alive: true, heartbeatAgeMs: 0 });
    expect(formatEnsureUp(ensureUpHealth(home, NOW), false)).toContain("ENSURE-UP up pid=");
    expect(formatEnsureUp({ alive: false }, true)).toBe("ENSURE-UP off (ensure-up.off)");
  });

  test("process lists parse on both shapes and match the merged entry plus a pre-merge shim", () => {
    expect(parseCim(JSON.stringify({ ProcessId: 7, CommandLine: "bun supervisor.ts" }))).toEqual([
      { pid: 7, command: "bun supervisor.ts" },
    ]);
    expect(
      parseCim(
        JSON.stringify([
          { ProcessId: 7, CommandLine: "a" },
          { ProcessId: 8, CommandLine: "b" },
        ]),
      ),
    ).toHaveLength(2);
    expect(parseCim("not json")).toEqual([]);
    expect(parsePs("  10 bun a.ts\n 11 bun b.ts\n")).toEqual([
      { pid: 10, command: "bun a.ts" },
      { pid: 11, command: "bun b.ts" },
    ]);
    const procs = [
      { pid: 1, command: "bun C:/home/bin/supervisor.ts" },
      { pid: 2, command: "bun C:/home/bin/gateway-supervisor.ts" },
      { pid: 3, command: "bun C:/home/bin/loops-supervisor.ts" },
      { pid: 4, command: "bun C:/home/bin/gateway-watchdog.ts" },
    ];
    expect(matchPids(procs, "supervisor.ts")).toEqual([1, 2, 3]);
    expect(matchPids(procs, "gateway-watchdog.ts", "supervisors/watchdog.ts")).toEqual([4]);
  });
});
