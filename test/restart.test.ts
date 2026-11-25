import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartSupervisors } from "../src/supervisor-restart.ts";
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

  test("an unverified duplicate fails the restart verdict and names the pid", async () => {
    const home = homeWithOnlyEnsureUpEnabled();
    const result = await restartSupervisors(home, {
      timeoutMs: 1_000,
      io: {
        kill: async () => [],
        dedupe: async () => ({ kept: process.pid, killed: [], unverified: [process.ppid] }),
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
    expect(result.missing).toContain(`ensure-up dedupe unverified=${process.ppid}`);
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
