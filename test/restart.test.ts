import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartLines, restartSupervisors } from "../src/supervisor-restart.ts";
import type { SupervisorHealth } from "../src/supervisors.ts";
import { homeWithState } from "./supervisor-fixtures.ts";

const CORE = ["discord-gateway", "duty", "loop"] as const;

function homeWithOnlyEnsureUpEnabled(): string {
  const home = homeWithState();
  writeFileSync(
    join(home, "state", "plugins.json"),
    JSON.stringify({ disabled: ["update-check", "gateway-catchup", "silence-check"] }),
  );
  return home;
}

function healthWhereUnitsAreThisProcess(units: readonly string[]): SupervisorHealth[] {
  return [
    {
      name: "supervisor",
      pid: process.pid,
      alive: true,
      units: units.map((name) => ({ name, pid: process.pid, alive: true })),
    },
    { name: "watchdog", pid: process.pid, alive: true, units: [] },
  ];
}

describe("dori restart", () => {
  test("the printed output names a headless unit in the UNITS line before the verdict", () => {
    const health: SupervisorHealth[] = [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        heartbeatAgeMs: 0,
        units: [
          { name: "discord-gateway", pid: 11, pane: "w1:p1", alive: true },
          { name: "duty", pid: 12, alive: true },
          { name: "loop", pid: 13, pane: "w1:p2", alive: true },
        ],
      },
      { name: "watchdog", pid: 2, alive: true, units: [] },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1_200,
        killed: [1],
        health,
        expected: ["discord-gateway", "duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        wsHeartbeatAgeMs: 1_000,
        retried: false,
        missing: [],
      },
      "panes",
    );
    expect(lines).toContain("UNITS panes=2/3 headless=duty dead=none missing=none");
    expect(lines.findIndex((line) => line.startsWith("UNITS "))).toBe(2);
    expect(lines.at(-1)).toBe("RESTARTED killed=1 ms=1200 ws=1s units=panes");
  });

  test("a short restart prints each missing piece after the UNITS line and before the verdict", () => {
    const lines = restartLines(
      {
        ok: false,
        elapsedMs: 500,
        killed: [],
        health: [{ name: "supervisor", pid: 1, alive: false, units: [] }],
        expected: ["duty"],
        ensureUp: { alive: false },
        off: true,
        retried: true,
        missing: ["unit du\nty missing"],
      },
      "headless",
    );
    expect(lines.at(-2)).toBe("RESTART MISSING unit du?ty missing");
    expect(lines.at(-1)).toBe("RESTART INCOMPLETE killed=0 ms=500 ws=missing retried=1 units=headless");
  });

  test("a dead unit beside its pane is reported dead, not placed", () => {
    const health: SupervisorHealth[] = [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        units: [
          { name: "duty", pid: 12, pane: "w1:p1", alive: true },
          { name: "loop", pid: 13, pane: "w1:p2", alive: false },
        ],
      },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1,
        killed: [],
        health,
        expected: ["duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        retried: false,
        missing: [],
      },
      "panes",
    );
    expect(lines).toContain("UNITS panes=1/2 headless=none dead=loop missing=none");
  });

  test("a headless restart still names every headless unit", () => {
    const health: SupervisorHealth[] = [
      { name: "supervisor", pid: 1, alive: true, units: [{ name: "duty", pid: 2, alive: true }] },
    ];
    const lines = restartLines(
      {
        ok: true,
        elapsedMs: 1,
        killed: [],
        health,
        expected: ["duty", "loop"],
        ensureUp: { alive: false },
        off: true,
        retried: false,
        missing: [],
      },
      "headless",
    );
    expect(lines).toContain("UNITS panes=0/2 headless=duty dead=none missing=loop");
    expect(lines.at(-1)).toContain("units=headless");
  });

  test("an attempt that comes back short is retried once and then settles", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    let ensures = 0;
    let recovered = false;
    let now = 1_000_000;
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => [],
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
        ensure: async () => {
          ensures += 1;
          recovered = ensures === 2;
          return [];
        },
        health: () =>
          healthWhereUnitsAreThisProcess(recovered ? [...CORE, "ensure-up"] : ["discord-gateway", "loop", "ensure-up"]),
        waitFresh: async () => true,
        waitEnsureUp: async () => ({ pid: process.pid, alive: true }),
        waitUnit: async () => true,
        dedupe: async () => ({ kept: process.pid, killed: [] }),
      },
    });
    expect(ensures).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.expected).toEqual([...CORE, "ensure-up"]);
  });

  test("the dedupe verdict travels with the restart result", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    const events: string[] = [];
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => {
          events.push("kill");
          return [];
        },
        dedupe: async () => {
          events.push("dedupe");
          return { kept: process.pid, killed: [12] };
        },
        ensure: async () => {
          events.push("ensure");
          return [];
        },
        health: () => healthWhereUnitsAreThisProcess([...CORE, "ensure-up"]),
        waitFresh: async () => true,
        waitEnsureUp: async () => ({ pid: 11, alive: true }),
        waitUnit: async () => {
          events.push("waitUnit");
          return true;
        },
        sleep: async () => {},
        now: () => 1_000,
      },
    });
    expect(events).toEqual(["kill", "dedupe", "ensure", "waitUnit", "dedupe"]);
    expect(result.dupes).toEqual({ kept: process.pid, killed: [12] });
    expect(result.ok).toBe(true);
  });

  test("a failed dedupe fails the restart verdict and names the pid", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => [],
        dedupe: async () => ({ kept: process.pid, killed: [], failed: [process.ppid] }),
        ensure: async () => [],
        health: () => healthWhereUnitsAreThisProcess([...CORE, "ensure-up"]),
        waitFresh: async () => true,
        waitEnsureUp: async () => ({ pid: 11, alive: true }),
        waitUnit: async () => true,
        sleep: async () => {},
        now: () => 1_000,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(`ensure-up dedupe failed=${process.ppid}`);
  });

  test("a killed duplicate whose replacement never beats fails the verdict", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => [],
        dedupe: async () => ({ kept: process.pid, killed: [process.pid + 1] }),
        ensure: async () => [],
        health: () => healthWhereUnitsAreThisProcess([...CORE, "ensure-up"]),
        waitFresh: async () => true,
        waitEnsureUp: async () => ({ alive: false }),
        waitUnit: async () => true,
        sleep: async () => {},
        now: () => 1_000,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  test("two failed attempts name each missing heartbeat and unit before the verdict", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    let ensures = 0;
    let now = 2_000_000;
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => [],
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
        ensure: async () => {
          ensures += 1;
          return [];
        },
        health: () => healthWhereUnitsAreThisProcess(["discord-gateway", "loop", "ensure-up"]),
        waitFresh: async () => false,
        waitEnsureUp: async () => ({ alive: false }),
        waitUnit: async () => true,
        dedupe: async () => ({ kept: process.pid, killed: [] }),
      },
    });
    expect(ensures).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("supervisor heartbeat missing");
    expect(result.missing).toContain("gateway-ws heartbeat missing");
    expect(result.missing).toContain("unit duty missing");
    expect(result.missing).toContain("ensure-up heartbeat missing");
  });
});
