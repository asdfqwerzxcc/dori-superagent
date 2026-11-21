import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import { laneRepo } from "../src/lane-repo.ts";
import { reviewLane } from "../src/lane-review.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

describe("lane worktrees", () => {
  const wtPath = (d: ReturnType<typeof setup>["d"], key: string) => join(d.store.root, "worktrees", key);
  const gitCalls = (w: World) => w.calls.filter((c) => c.cmd === "git").map((c) => c.argv.join(" "));

  test("start records the worktree, review reads it, and done lands then removes it", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "own-tree", brief, { group: "w1" });
    const wt = wtPath(d, "own-tree");
    expect(lane.worktree).toBe(wt);
    expect(laneRepo(lane)).toBe(wt);

    repo.worktreeHead = tip;
    await ready(d, "own-tree", "landed", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect(await reviewLane(d, "own-tree")).toEqual({ verdict: "CLEAR", base, tip });

    expect(await done(d, "own-tree")).toBeUndefined();
    const gits = gitCalls(w);
    expect(gits).toContain("-C /repo merge --ff-only lane/own-tree");
    expect(gits).toContain(`-C /repo worktree unlock ${wt}`);
    expect(gits).toContain(`-C /repo worktree remove ${wt}`);
    expect(gits).toContain("-C /repo branch -d lane/own-tree");
    expect(gits).toContain(`-C ${wt} status --porcelain`);
    expect(d.store.lane("own-tree")!.status).toBe("done");
    expect(d.store.lane("own-tree")!.log.at(-1)!.text).toContain("landed lane/own-tree on main");
  });

  test("done refuses a dirty worktree before it closes the pane or touches main", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff, dirty: " M src/x.ts\n" };
    fakeGit(w, repo);
    const lane = await startLane(d, "dirty", brief, { group: "w1" });
    await ready(d, "dirty", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "dirty");

    await expect(done(d, "dirty")).rejects.toThrow("M src/x.ts");
    expect(d.store.lane("dirty")!.status).toBe("ready");
    expect(w.panes.has(lane.paneId)).toBe(true);
    const gits = gitCalls(w);
    expect(gits).not.toContain("-C /repo merge --ff-only lane/dirty");
    expect(gits).not.toContain(`-C /repo worktree remove ${wtPath(d, "dirty")}`);
  });

  test("done refuses when main moved and keeps the branch and worktree", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "moved", brief, { group: "w1" });
    await ready(d, "moved", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "moved");

    repo.head = "c".repeat(40);
    repo.ancestor = false;
    await expect(done(d, "moved")).rejects.toThrow("main moved: rebase required");
    expect(d.store.lane("moved")!.worktree).toBe(wtPath(d, "moved"));
    expect(d.store.lane("moved")!.status).toBe("ready");
    expect(w.panes.has(lane.paneId)).toBe(false);
    const gits = gitCalls(w);
    expect(gits).not.toContain(`-C /repo worktree remove ${wtPath(d, "moved")}`);
    expect(gits).not.toContain("-C /repo branch -d lane/moved");
  });

  test("done lands a squash-merged lane by content and removes its worktree", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "squashed", brief, { group: "w1" });
    await ready(d, "squashed", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "squashed");

    // The squash merge rewrote the lane's commit on main: same tree, new sha, so ancestry alone fails.
    repo.head = "c".repeat(40);
    repo.ancestor = false;
    repo.contentDiff = "";
    expect(await done(d, "squashed")).toBeUndefined();
    const gits = gitCalls(w);
    expect(gits).toContain("-C /repo diff --quiet lane/squashed HEAD");
    expect(gits).not.toContain("-C /repo merge --ff-only lane/squashed");
    expect(gits).toContain(`-C /repo worktree remove ${wtPath(d, "squashed")}`);
    expect(gits).toContain("-C /repo branch -D lane/squashed");
    const closed = d.store.lane("squashed")!;
    expect(closed.status).toBe("done");
    expect(closed.log.at(-1)!.text).toContain("landed by content (squash)");
    expect(w.panes.has(lane.paneId)).toBe(false);
  });

  test("done still refuses a moved main whose content differs", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "not-squashed", brief, { group: "w1" });
    await ready(d, "not-squashed", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "not-squashed");

    repo.head = "c".repeat(40);
    repo.ancestor = false;
    repo.contentDiff = diff;
    await expect(done(d, "not-squashed")).rejects.toThrow("main moved: rebase required");
    const gits = gitCalls(w);
    expect(gits).toContain("-C /repo diff --quiet lane/not-squashed HEAD");
    expect(gits).not.toContain(`-C /repo worktree remove ${wtPath(d, "not-squashed")}`);
    expect(gits).not.toContain("-C /repo branch -D lane/not-squashed");
    expect(d.store.lane("not-squashed")!.status).toBe("ready");
    expect(d.store.lane("not-squashed")!.worktree).toBe(wtPath(d, "not-squashed"));
  });

  test("done keeps the ancestor path and never probes content", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "ancestor", brief, { group: "w1" });
    await ready(d, "ancestor", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "ancestor");

    repo.head = "c".repeat(40);
    repo.ancestor = true;
    expect(await done(d, "ancestor")).toBeUndefined();
    const gits = gitCalls(w);
    expect(gits).toContain("-C /repo merge-base --is-ancestor lane/ancestor HEAD");
    expect(gits).not.toContain("-C /repo diff --quiet lane/ancestor HEAD");
    expect(gits).not.toContain("-C /repo merge --ff-only lane/ancestor");
    expect(d.store.lane("ancestor")!.status).toBe("done");
  });

  test("done refuses a lane whose pane runs outside its own worktree", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "elsewhere", brief, { group: "w1" });
    await ready(d, "elsewhere", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "elsewhere");

    const pane = w.panes.get(lane.paneId)!;
    w.panes.set(lane.paneId, { ...pane, cwd: "/repo" });
    await expect(done(d, "elsewhere")).rejects.toThrow("is not its worktree");
    expect(d.store.lane("elsewhere")!.status).toBe("ready");
    expect(gitCalls(w)).not.toContain("-C /repo merge --ff-only lane/elsewhere");
  });

  test("done --rebase moves the lane onto main, re-records the base, then demands a fresh receipt", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "rebound", brief, { group: "w1" });
    await ready(d, "rebound", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "rebound");

    const moved = "c".repeat(40);
    repo.head = moved;
    repo.ancestor = false;
    // The rebase rewrites the lane's commit, so the tip the old receipt covered no longer exists.
    repo.worktreeHead = "d".repeat(40);
    const failure: unknown = await done(d, "rebound", { rebase: true }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeDefined();
    expect(gitCalls(w)).toContain(`-C ${wtPath(d, "rebound")} rebase main`);
    expect(d.store.lane("rebound")!.baseSha).toBe(moved);
    expect(d.store.lane("rebound")!.status).toBe("ready");
    expect(gitCalls(w)).not.toContain("-C /repo merge --ff-only lane/rebound");
  });

  test("a retried done removes a branch main already contains without merging twice", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "retry", brief, { group: "w1" });
    await ready(d, "retry", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "retry");

    repo.head = "c".repeat(40);
    repo.ancestor = true;
    expect(await done(d, "retry")).toBeUndefined();
    expect(gitCalls(w)).not.toContain("-C /repo merge --ff-only lane/retry");
    expect(d.store.lane("retry")!.status).toBe("done");
  });

  test("done --drop removes the worktree and branch without merging", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "drop-me", brief, { group: "w1" });

    expect(await done(d, "drop-me", { drop: "abandoned" })).toBe("dropped: abandoned");
    expect(d.store.lane("drop-me")!.status).toBe("dropped");
    expect(d.store.lane("drop-me")!.log.at(-1)).toMatchObject({ kind: "dropped", text: "abandoned" });
    expect(w.panes.has(lane.paneId)).toBe(false);
    const gits = gitCalls(w);
    expect(gits).toContain(`-C /repo worktree remove ${wtPath(d, "drop-me")}`);
    expect(gits).toContain("-C /repo branch -D lane/drop-me");
    expect(gits).not.toContain("-C /repo merge --ff-only lane/drop-me");
  });

  test("status names a pane whose cwd is not its worktree", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "wrong-cwd", brief, { group: "w1" });
    w.panes.get(lane.paneId)!.cwd = "/shared";

    const { out } = await captureIo(async () => {
      await status(d);
      return 0;
    });
    expect(out).toContain(`MISMATCH wrong-cwd: pane cwd /shared is not its worktree ${wtPath(d, "wrong-cwd")}`);
  });

  test("a BLOCK receipt cannot land; --drop removes it and main stays put", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, worktreeHead: tip, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "blocked", brief, { group: "w1" });
    await ready(d, "blocked", "done", ["file:///x"]);
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/x.ts:1 bug\nVERDICT: BLOCK" });
    await reviewLane(d, "blocked");

    await expect(done(d, "blocked")).rejects.toThrow("is BLOCK");
    expect(d.store.lane("blocked")!.status).toBe("ready");
    expect(await done(d, "blocked", { drop: "blocked" })).toBe("dropped: blocked");
    expect(d.store.lane("blocked")!.status).toBe("dropped");
    expect(gitCalls(w)).not.toContain("-C /repo merge --ff-only lane/blocked");
  });
});
