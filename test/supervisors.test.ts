import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUpHealth, formatEnsureUp, formatSupervisor, supervisorHealth } from "../src/supervisors.ts";
import { matchPids, parseCim, parsePs } from "../src/supervisor-run.ts";
import { NOW, beat, homeWithState, loopsRecord } from "./supervisor-fixtures.ts";

describe("supervisor records and heartbeats", () => {
  test("a fresh beat plus the recorded pid is up, with each unit's liveness beside it", () => {
    const home = homeWithState();
    beat(home, "loops-heartbeat");
    loopsRecord(home);
    const [gateway, loops] = supervisorHealth(home, NOW);
    expect(gateway).toMatchObject({ name: "gateway", alive: false, units: [] });
    expect(loops).toMatchObject({ name: "loops", pid: process.pid, alive: true, heartbeatAgeMs: 0 });
    expect(loops?.units).toEqual([{ name: "duty", pid: process.pid, alive: true }]);
    expect(formatSupervisor(loops!)).toBe(`SUPERVISED loops    up pid=${process.pid} hb=0s units=duty:${process.pid}`);
  });

  test("a stale beat or a dead recorded pid is DOWN, and a dead unit says so", () => {
    const home = homeWithState();
    beat(home, "loops-heartbeat", NOW - 300_000);
    loopsRecord(home);
    expect(supervisorHealth(home, NOW)[1]).toMatchObject({ name: "loops", alive: false, heartbeatAgeMs: 300_000 });

    beat(home, "loops-heartbeat");
    const dead = supervisorHealth(home, NOW, () => false)[1];
    expect(dead).toMatchObject({ name: "loops", alive: false });
    expect(formatSupervisor(dead!)).toContain("(dead)");
  });

  test("ensure-up has its own record and beat; the off file is reported separately", () => {
    const home = homeWithState();
    beat(home, "ensure-up-heartbeat");
    writeFileSync(join(home, "state", "ensure-up.json"), JSON.stringify({ pid: process.pid, startedAt: NOW, at: NOW }));
    expect(ensureUpHealth(home, NOW)).toMatchObject({ pid: process.pid, alive: true, heartbeatAgeMs: 0 });
    expect(formatEnsureUp(ensureUpHealth(home, NOW), false)).toContain("ENSURE-UP up pid=");
    expect(formatEnsureUp({ alive: false }, true)).toBe("ENSURE-UP off (ensure-up.off)");
  });

  test("process lists parse on both shapes and match by command line", () => {
    expect(parseCim(JSON.stringify({ ProcessId: 7, CommandLine: "bun gateway-supervisor.ts" }))).toEqual([
      { pid: 7, command: "bun gateway-supervisor.ts" },
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
      { pid: 1, command: "bun gateway-supervisor.ts" },
      { pid: 2, command: "bun loops-supervisor.ts" },
      { pid: 3, command: "bun supervisors/watchdog.ts" },
    ];
    expect(matchPids(procs, "loops-supervisor.ts", "supervisors/loops.ts")).toEqual([2]);
    expect(matchPids(procs, "gateway-supervisor.ts", "supervisors/gateway.ts")).toEqual([1]);
  });
});
