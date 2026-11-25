import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePluginRecord } from "../src/plugins/state.ts";
import { dedupeEnsureUp } from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;
const HOLDER = 7003;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-owners-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const writeLock = (home: string, pid: number, startedAt?: number): void => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  writeFileSync(
    join(home, "state", "plugins", "ensure-up.lock"),
    JSON.stringify({ pid, at: Date.now(), ...(startedAt === undefined ? {} : { startedAt }) }),
  );
};

const writeSupervisor = (home: string, unitPid: number, unitAt: number, unitStartedAt?: number): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid: 7001,
    startedAt: NOW - 60_000,
    units: [
      {
        name: "ensure-up",
        pid: unitPid,
        at: unitAt,
        ...(unitStartedAt === undefined ? {} : { startedAt: unitStartedAt }),
      },
    ],
    at: NOW,
  });
};

const writeContender = (home: string, pid: number, at: number): void => {
  mkdirSync(join(home, "state", "plugins", "ensure-up.contenders"), { recursive: true });
  writeFileSync(join(home, "state", "plugins", "ensure-up.contenders", `${pid}.json`), JSON.stringify({ pid, at }));
};

type Harness = { readonly alive: Set<number>; readonly startAt: Map<number, number> };

const harness = (pids: readonly number[]): Harness => ({ alive: new Set(pids), startAt: new Map() });

describe("ensure-up owners and kill fences", () => {
  test("a disabled plugin ends a unit registered 5s after its process start", async () => {
    const home = homeWithState();
    writeSupervisor(home, HOLDER, NOW, NOW - 5_000);
    const h = harness([HOLDER]);
    h.startAt.set(HOLDER, NOW - 5_000);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: (pid) => h.startAt.get(pid) ?? null,
      keep: false,
    });
    expect(result).toEqual({ killed: [HOLDER] });
  });

  test("a stale unit record does not shield a reused pid or kill the real replacement", async () => {
    const home = homeWithState();
    const staleUnit = 7400;
    const keeper = 7401;
    const replacement = 7402;
    writeSupervisor(home, staleUnit, NOW - 60_000);
    writeEnsureUpRecord(home, { pid: staleUnit, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: replacement, startedAt: NOW, at: NOW });
    writeLock(home, keeper, NOW);
    const h = harness([staleUnit, keeper, replacement]);
    h.startAt.set(staleUnit, NOW);
    h.startAt.set(keeper, NOW);
    h.startAt.set(replacement, NOW);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: (pid) => h.startAt.get(pid) ?? null,
    });
    expect(result.kept).toBe(keeper);
    expect(result.killed).toContain(staleUnit);
    expect(result.killed).not.toContain(replacement);
  });

  test("a unit replaced between reads is not treated as a duplicate", async () => {
    const home = homeWithState();
    const keeper = 7100;
    const oldUnit = 7101;
    const newUnit = 7102;
    writeLock(home, keeper, NOW);
    const h = harness([keeper, newUnit]);
    h.startAt.set(keeper, NOW);
    h.startAt.set(newUnit, NOW);
    let calls = 0;
    const reader = () => {
      calls++;
      return {
        name: "supervisor" as const,
        pid: 7001,
        startedAt: NOW - 60_000,
        units: [{ name: "ensure-up", pid: calls === 1 ? oldUnit : newUnit, at: NOW }],
        at: NOW,
      };
    };
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: (pid) => h.startAt.get(pid) ?? null,
      supervisor: reader,
    });
    expect(calls).toBe(1);
    expect(result.killed).not.toContain(newUnit);
    expect(h.alive.has(newUnit)).toBe(true);
  });

  test("a dead unverified pid is not reported", async () => {
    const home = homeWithState();
    const keeper = 7200;
    const target = 7201;
    const unsure = 7202;
    writeLock(home, keeper, NOW);
    writeEnsureUpRecord(home, { pid: target, startedAt: NOW, at: NOW });
    writePluginRecord(home, { name: "ensure-up", pid: unsure, startedAt: NOW, at: NOW });
    const h = harness([keeper, target, unsure]);
    h.startAt.set(keeper, NOW);
    h.startAt.set(target, NOW);
    h.startAt.set(unsure, NOW - 5_000);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        if (pid === target) h.alive.delete(unsure);
        return true;
      },
      started: (pid) => h.startAt.get(pid) ?? null,
    });
    expect(result.killed).toEqual([target]);
    expect(result.unverified).toBeUndefined();
  });

  test("a target that becomes the holder during confirmation is not killed", async () => {
    const home = homeWithState();
    const keeper = 7300;
    const target = 7301;
    mkdirSync(join(home, "state", "plugins", "ensure-up.lock"), { recursive: true });
    const owner = join(home, "state", "plugins", "ensure-up.lock", "owner.json");
    writeFileSync(owner, JSON.stringify({ version: 1, pid: keeper, at: NOW, startedAt: NOW }));
    writeContender(home, target, NOW);
    const h = harness([keeper, target]);
    let fired = false;
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      same: () => true,
      started: (pid) => {
        if (pid === target && !fired) {
          fired = true;
          writeFileSync(owner, JSON.stringify({ version: 1, pid: target, at: NOW, startedAt: NOW }));
        }
        return NOW;
      },
      now: () => NOW,
    });
    expect(result.killed).not.toContain(target);
    expect(h.alive.has(target)).toBe(true);
  });
});
