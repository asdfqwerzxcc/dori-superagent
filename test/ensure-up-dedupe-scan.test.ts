import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedupeEnsureUp } from "../src/supervise-home.ts";
import { writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;
const SUPERVISOR = 7001;
const UNIT = 7002;
const OTHER = 7005;
const CONTENDER = 7006;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-scan-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const writeSupervisor = (home: string): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid: SUPERVISOR,
    startedAt: NOW - 60_000,
    units: [{ name: "ensure-up", pid: UNIT, at: NOW - 60_000, startedAt: NOW - 60_000 }],
    at: NOW - 60_000,
  });
};

describe("a scanned idle duplicate", () => {
  test("a scanned loop with a matching OS start is ended; an unreadable start is unverified", async () => {
    const home = homeWithState();
    writeSupervisor(home);
    const alive = new Set([SUPERVISOR, UNIT, OTHER, CONTENDER]);
    const startTimes = new Map<number, number | null>([
      [UNIT, NOW - 60_000],
      [OTHER, NOW],
      [CONTENDER, null],
    ]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => alive.has(pid),
      kill: (pid) => alive.delete(pid),
      started: (pid) => startTimes.get(pid) ?? null,
      scan: () => [OTHER, CONTENDER],
      graceMs: 0,
      now: () => NOW,
    });
    expect(result.kept).toBe(UNIT);
    expect(result.killed).toEqual([OTHER]);
    expect(alive.has(OTHER)).toBe(false);
    expect(result.unverified).toEqual([CONTENDER]);
    expect(alive.has(CONTENDER)).toBe(true);
  });

  test("no scan means no candidate, so the records still decide alone", async () => {
    const home = homeWithState();
    writeSupervisor(home);
    const alive = new Set([SUPERVISOR, UNIT]);
    const result = await dedupeEnsureUp(home, {
      alive: (pid) => alive.has(pid),
      kill: (pid) => alive.delete(pid),
      started: (pid) => (pid === UNIT ? NOW - 60_000 : null),
      scan: () => [],
      graceMs: 0,
      now: () => NOW,
    });
    expect(result).toEqual({ kept: UNIT, keptAt: NOW - 60_000, killed: [] });
  });
});
