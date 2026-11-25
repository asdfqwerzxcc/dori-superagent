import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeEnsureUp, mergeEnsureUpDedupe } from "../src/supervise-home.ts";

const NOW = 1_800_000_000_000;
const HOLDER = 7003;
const CONTENDER = 7005;
const OTHER = 7004;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-doubt-"));
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

const writeContender = (home: string, pid: number, at: number): void => {
  mkdirSync(join(home, "state", "plugins", "ensure-up.contenders"), { recursive: true });
  writeFileSync(join(home, "state", "plugins", "ensure-up.contenders", `${pid}.json`), JSON.stringify({ pid, at }));
};

type Harness = { readonly alive: Set<number>; readonly startAt: Map<number, number> };

const harness = (pids: readonly number[]): Harness => ({ alive: new Set(pids), startAt: new Map() });

const dedupe = (home: string, h: Harness, kill?: (pid: number) => boolean) =>
  dedupeEnsureUp(home, {
    alive: (pid) => h.alive.has(pid),
    kill:
      kill ??
      ((pid) => {
        h.alive.delete(pid);
        return true;
      }),
    same: (child) => {
      const started = h.startAt.get(child.pid);
      return h.alive.has(child.pid) && (started === undefined || started === child.at);
    },
  });

describe("ensure-up doubt and beats", () => {
  test("a 5s start-time mismatch is not elected, even though it is less than the old 10s slack", async () => {
    const home = homeWithState();
    writeLock(home, HOLDER, NOW);
    const h = harness([HOLDER]);
    h.startAt.set(HOLDER, NOW - 5_000);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: (pid) => h.startAt.get(pid) ?? null,
    });
    expect(result).toEqual({ killed: [], unverified: [HOLDER] });
    expect(result.kept).toBeUndefined();
  });

  test("a null-start lock holder is protected as the keeper", async () => {
    const home = homeWithState();
    mkdirSync(join(home, "state", "plugins", "ensure-up.lock"), { recursive: true });
    writeFileSync(
      join(home, "state", "plugins", "ensure-up.lock", "owner.json"),
      JSON.stringify({ version: 1, pid: HOLDER, at: NOW, startedAt: null }),
    );
    const h = harness([HOLDER]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: () => null,
    });
    expect(result.kept).toBe(HOLDER);
    expect(result.killed).toEqual([]);
  });

  test("a disabled plugin reports a null-start lock holder as unverified", async () => {
    const home = homeWithState();
    mkdirSync(join(home, "state", "plugins", "ensure-up.lock"), { recursive: true });
    writeFileSync(
      join(home, "state", "plugins", "ensure-up.lock", "owner.json"),
      JSON.stringify({ version: 1, pid: HOLDER, at: NOW, startedAt: null }),
    );
    const h = harness([HOLDER]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => h.alive.has(pid),
      kill: (pid) => {
        h.alive.delete(pid);
        return true;
      },
      started: () => null,
      keep: false,
    });
    expect(result).toEqual({ killed: [], unverified: [HOLDER] });
  });

  test("a keeper that dies before the final verdict is not returned", async () => {
    const home = homeWithState();
    writeLock(home, HOLDER, NOW);
    let calls = 0;
    const alive = (pid: number): boolean => {
      if (pid !== HOLDER) return false;
      calls++;
      return calls < 4;
    };
    const result = await dedupeEnsureUp(home, {
      alive,
      kill: () => true,
      started: () => NOW,
    });
    expect(result.kept).toBeUndefined();
    expect(result.killed).toEqual([]);
  });

  test("merge drops a kept pid from killed and a failed pid from unverified", () => {
    expect(mergeEnsureUpDedupe({ kept: 5, killed: [5] }, { killed: [] }, () => true).killed).toEqual([]);
    const merged = mergeEnsureUpDedupe({ killed: [], failed: [3] }, { killed: [], unverified: [3] }, () => true);
    expect(merged.unverified).toBeUndefined();
    expect(merged.failed).toEqual([3]);
    expect(
      mergeEnsureUpDedupe({ killed: [], unverified: [9] }, { killed: [] }, () => false).unverified,
    ).toBeUndefined();
  });

  test("the freshest contender is its refreshed file, not its old start time", async () => {
    const home = homeWithState();
    const dir = join(home, "state", "plugins", "ensure-up.contenders");
    writeContender(home, CONTENDER, NOW - 60_000);
    writeContender(home, OTHER, NOW - 60_000);
    utimesSync(join(dir, `${CONTENDER}.json`), new Date(NOW - 10_000), new Date(NOW - 10_000));
    utimesSync(join(dir, `${OTHER}.json`), new Date(NOW), new Date(NOW));
    const h = harness([CONTENDER, OTHER]);
    h.startAt.set(CONTENDER, NOW - 60_000);
    h.startAt.set(OTHER, NOW - 60_000);
    const result = await dedupe(home, h);
    expect(result.kept).toBe(OTHER);
  });

  test("a corrupt record pid is skipped before liveness or a kill", async () => {
    const home = homeWithState();
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "ensure-up.json"), JSON.stringify({ pid: "7006", startedAt: NOW, at: NOW }));
    const killed: number[] = [];
    const result = await dedupeEnsureUp(home, {
      alive: () => true,
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
      same: () => true,
      started: () => NOW,
    });
    expect(killed).toEqual([]);
    expect(result.killed).toEqual([]);
  });
});
