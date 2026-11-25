import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseHome } from "../src/supervisor-run.ts";
import { writeSupervisorRecord, type SupervisorHealth } from "../src/supervisors.ts";

const SUP_PID = 4242;
const SUP_START = 1_700_000_000_000;
const SUP_AT = SUP_START;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-owner-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const writeRecord = (home: string): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid: SUP_PID,
    startedAt: SUP_START,
    units: [],
    at: SUP_AT,
  });
};

describe("superviseHome ownership", () => {
  test("a late beat does not dethrone a live recorded supervisor, and startMissing never spawns the plugin", async () => {
    const home = homeWithState();
    writeRecord(home);
    let spawns = 0;
    const wanted: boolean[] = [];
    const state = await superviseHome(home, {
      startMissing: false,
      alive: (pid) => pid === SUP_PID,
      started: () => SUP_START,
      spawn: () => {
        spawns += 1;
        return 1;
      },
      wait: async (_home, want, timeoutMs = 0) => {
        wanted.push(want);
        void timeoutMs;
        return { alive: false };
      },
    });
    expect(state.health.some((h) => h.name === "supervisor" && h.alive)).toBe(false);
    expect(wanted).toContain(true);
    expect(spawns).toBe(0);
    expect(state.ensureUp.alive).toBe(false);

    const empty = homeWithState();
    let started = 0;
    await superviseHome(empty, {
      startMissing: true,
      ensure: async () => [],
      alive: () => false,
      started: () => null,
      spawn: () => {
        started += 1;
        return 1;
      },
      wait: async () => ({ alive: false }),
    });
    expect(started).toBe(0);
  });

  test("a fresh heartbeat is the fallback only when no supervisor record exists", async () => {
    const home = homeWithState();
    const fresh: SupervisorHealth[] = [{ name: "supervisor", pid: SUP_PID, alive: true, units: [] }];
    let spawns = 0;
    const wanted: boolean[] = [];
    const state = await superviseHome(home, {
      startMissing: false,
      alive: () => false,
      health: fresh,
      spawn: () => {
        spawns += 1;
        return 1;
      },
      wait: async (_home, want) => {
        wanted.push(want);
        return { alive: false };
      },
    });
    expect(state.health).toEqual(fresh);
    expect(wanted).toContain(true);
    expect(spawns).toBe(0);
  });

  test("a fresh heartbeat does not revive a dead recorded supervisor", async () => {
    const home = homeWithState();
    writeRecord(home);
    const fresh: SupervisorHealth[] = [{ name: "supervisor", pid: SUP_PID, alive: true, units: [] }];
    let spawns = 0;
    const wanted: boolean[] = [];
    const state = await superviseHome(home, {
      startMissing: false,
      alive: () => false,
      started: () => SUP_START,
      health: fresh,
      spawn: () => {
        spawns += 1;
        return 1;
      },
      wait: async (_home, want) => {
        wanted.push(want);
        return { alive: false };
      },
    });
    expect(state.health).toEqual(fresh);
    expect(wanted).toContain(true);
    expect(spawns).toBe(1);
  });
});
