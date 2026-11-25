import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureUpHealth,
  formatEnsureUp,
  formatSupervised,
  formatSupervisor,
  supervisorHealth,
  supervisorRecord as readSupervisorRecord,
  writeSupervisorRecord,
  type SupervisorHealth,
} from "../src/supervisors.ts";
import { formatUnitPlacement } from "../src/unit-placement.ts";
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

  test("a unit's pane id is shown beside its pid and liveness", () => {
    const home = homeWithState();
    beat(home, "supervisor-heartbeat");
    writeSupervisorRecord(home, {
      name: "supervisor",
      pid: process.pid,
      startedAt: NOW,
      units: [{ name: "duty", pid: process.pid, at: NOW, pane: "w9:p3" }],
      at: NOW,
    });
    expect(formatSupervisor(supervisorHealth(home, NOW)[0]!)).toBe(
      `SUPERVISED supervisor up pid=${process.pid} hb=0s units=duty:${process.pid}@w9:p3`,
    );
  });

  test("the unit placement line names every headless unit instead of a tab count", () => {
    const health: SupervisorHealth[] = [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        units: [
          { name: "duty", pid: 2, pane: "w1:p1", alive: true },
          { name: "loop", pid: 3, alive: true },
        ],
      },
      { name: "watchdog", pid: 4, alive: true, units: [] },
    ];
    expect(formatUnitPlacement(health, ["duty", "loop", "silence-check"])).toBe(
      "UNITS panes=1/3 headless=loop dead=none missing=silence-check",
    );
    expect(formatUnitPlacement(health, ["duty", "loop", "silence-check"], true)).toBe(
      "UNITS snapshot=startup panes=1/3 headless=loop dead=none missing=silence-check",
    );
    expect(formatUnitPlacement([], ["duty"])).toBe("UNITS panes=0/1 headless=none dead=none missing=duty");
  });

  test("dead units are dead with or without a pane, and names are stripped of control characters", () => {
    const dead = formatUnitPlacement(
      [
        {
          name: "supervisor",
          pid: 1,
          alive: true,
          units: [
            { name: "duty", pid: 2, pane: "w1:p1", alive: true },
            { name: "loop", pid: 3, pane: "w1:p2", alive: false },
            { name: "relay", pid: 5, alive: false },
            { name: "du\nty", pid: 4, alive: true },
          ],
        },
      ],
      ["duty", "loop", "relay", "du\nty"],
    );
    expect(dead).toBe("UNITS panes=1/4 headless=du?ty dead=loop,relay missing=none");
    expect(dead).not.toContain("\n");
  });

  test("the supervisor line strips control characters from unit names and panes", () => {
    const line = formatSupervisor({
      name: "supervisor",
      pid: 1,
      alive: true,
      units: [{ name: "du\u202ety", pid: 2, pane: "w1:p1", alive: true }],
    });
    expect(line).toContain("units=du?ty:2@w1:p1");
    expect(line).not.toContain("\u202e");
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

  test("the raw record is the pid and start time a restart trusts", () => {
    const home = homeWithState();
    supervisorRecord(home);
    expect(readSupervisorRecord(home, "supervisor")).toMatchObject({ pid: process.pid, units: expect.any(Array) });
    expect(readSupervisorRecord(home, "watchdog")).toBeUndefined();
  });
});
