import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartSupervisors } from "../src/supervisor-run.ts";
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
      },
    });
    expect(ensures).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
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
