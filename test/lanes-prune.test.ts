import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pruneLaneRecords } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const DAY = 86_400_000;

const lane = (
  d: ReturnType<typeof setup>["d"],
  key: string,
  status: "done" | "dropped" | "working",
  ageDays: number,
) => {
  const at = d.now() - ageDays * DAY;
  d.store.saveLane({
    key,
    sessionRef: { runtime: "herdr", id: `w1:p${key.length}` },
    paneId: `w1:p${key.length}`,
    tabId: "w1:t1",
    brief: d.store.briefPath(key),
    cwd: d.store.root,
    worktree: join(d.store.root, "worktrees", key),
    repo: d.store.root,
    baseSha: "a".repeat(40),
    tipSha: "b".repeat(40),
    status,
    createdAt: at,
    lastActivityAt: at,
    nudges: 0,
    log: [],
  });
};

describe("lanes prune", () => {
  test("removes finished records older than the cutoff and keeps everything else", () => {
    const { d } = setup();
    lane(d, "old-done", "done", 30);
    lane(d, "old-dropped", "dropped", 10);
    lane(d, "new-done", "done", 1);
    lane(d, "still-working", "working", 30);

    const result = pruneLaneRecords(d, 7);
    expect([...result.removed].sort()).toEqual(["old-done", "old-dropped"]);
    expect(result.kept).toBe(2);
    expect(d.store.lane("old-done")).toBeUndefined();
    expect(d.store.lane("old-dropped")).toBeUndefined();
    expect(d.store.lane("new-done")).toBeDefined();
    expect(d.store.lane("still-working")).toBeDefined();
  });

  test("a dry run reports the same list and deletes nothing", () => {
    const { d } = setup();
    lane(d, "old-done", "done", 30);
    const result = pruneLaneRecords(d, 7, d.now(), true);
    expect(result.removed).toEqual(["old-done"]);
    expect(d.store.lane("old-done")).toBeDefined();
  });

  test("a finished lane whose worktree still exists is reported, never deleted", () => {
    const { d } = setup();
    lane(d, "kept-tree", "done", 30);
    mkdirSync(join(d.store.root, "worktrees", "kept-tree"), { recursive: true });

    const result = pruneLaneRecords(d, 7);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual(["kept-tree"]);
    expect(d.store.lane("kept-tree")).toBeDefined();
  });
});
