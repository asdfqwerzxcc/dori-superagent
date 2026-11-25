import { describe, expect, test } from "bun:test";
import type { Deps } from "../src/harness.ts";
import { pickLaneReceipt } from "../src/lane-patch.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { attestLane } from "../src/review-lane-cli.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const rebased = "c".repeat(40);
const other = "d".repeat(40);
const patch = "1".repeat(40);
const changed = "2".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

const receipt = (over: Partial<LaneReceipt>): LaneReceipt => ({
  lane: "fix-login",
  verdict: "CLEAR",
  base,
  tip,
  brief: "brief",
  reviewer: "reviewer",
  at: 1,
  summary: "",
  ...over,
});

async function laneWorld() {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff, patchId: patch };
  fakeGit(s.w, repo);
  await startLane(s.d, "fix-login", s.brief, { group: "w1" });
  await ready(s.d, "fix-login", "fixed", ["file:///fix-login"]);
  repo.head = tip;
  return { ...s, repo };
}

const attest = (d: Deps) =>
  attestLane(d, "fix-login", { verdict: "CLEAR", reviewer: "reviewer", evidence: ["file:///report"] });

describe("patch-id receipt judgment", () => {
  test("an exact tip wins; another tip is covered only by the same patch-id", () => {
    const older = receipt({ tip, patchId: patch });
    expect(pickLaneReceipt([older], tip, changed)).toBe(older);
    expect(pickLaneReceipt([older], rebased, patch)).toBe(older);
    expect(pickLaneReceipt([older], rebased, changed)).toBeUndefined();
    expect(pickLaneReceipt([older], rebased, undefined)).toBeUndefined();
  });

  test("a BLOCK for the same patch beats a CLEAR, whatever its time", () => {
    const clear = receipt({ tip, patchId: patch, at: 99 });
    const block = receipt({ tip: other, verdict: "BLOCK", patchId: patch, at: 1 });
    expect(pickLaneReceipt([clear, block], rebased, patch)?.verdict).toBe("BLOCK");
    expect(pickLaneReceipt([clear, block], tip, patch)).toBe(clear);
  });
});

describe("patch-id lane receipts", () => {
  test("attestation records the patch-id, and a rebase-only move keeps the CLEAR receipt", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    expect(d.store.laneReceipt("fix-login", tip)?.patchId).toBe(patch);

    repo.head = rebased;
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("a changed patch is not covered: done still refuses and asks for a review", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    repo.head = rebased;
    repo.patchId = changed;
    await expect(done(d, "fix-login")).rejects.toThrow("no review receipt");
    expect(d.store.lane("fix-login")!.status).toBe("ready");
  });

  test("a BLOCK cannot be cleared by moving only the SHA", async () => {
    const { d, repo } = await laneWorld();
    await attestLane(d, "fix-login", { verdict: "BLOCK", reviewer: "reviewer", evidence: ["file:///report"] });
    repo.head = rebased;
    await expect(done(d, "fix-login")).rejects.toThrow("is BLOCK");
    const kept = await attest(d);
    expect(kept).toMatchObject({ verdict: "BLOCK", kept: true });
    expect(d.store.laneReceipt("fix-login", rebased)).toBeUndefined();
  });

  test("done --rebase keeps the CLEAR receipt when the rebase leaves the patch unchanged", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    repo.head = rebased;
    repo.ancestor = false;
    repo.worktreeHead = other;
    expect(await done(d, "fix-login", { rebase: true })).toBeUndefined();
    expect(d.store.lane("fix-login")!.baseSha).toBe(rebased);
  });

  test("a receipt written before patch-id still gates its exact tip", async () => {
    const { d } = await laneWorld();
    d.store.saveLaneReceipt(receipt({ tip }));
    expect(d.store.laneReceipt("fix-login", tip)?.patchId).toBeUndefined();
    expect(await done(d, "fix-login")).toBeUndefined();
  });
});
