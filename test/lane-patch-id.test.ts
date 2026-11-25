import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Deps } from "../src/harness.ts";
import { pickLaneReceipt } from "../src/lane-patch.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { attestLane } from "../src/review-lane-cli.ts";
import { queueLaneReview, reviewJobFor } from "../src/review-queue.ts";
import { jobPath } from "../src/review-job.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const rebased = "c".repeat(40);
const other = "d".repeat(40);
const patch = "1".repeat(40);
const changed = "2".repeat(40);
const content = "3".repeat(40);
const otherContent = "4".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";
const changedDiff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 2;\n";

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

const laneAttest = (d: Deps, verdict: "CLEAR" | "BLOCK" = "CLEAR") =>
  attestLane(d, "fix-login", { verdict, reviewer: "reviewer", evidence: ["file:///report"] });

const attest = async (d: Deps, verdict: "CLEAR" | "BLOCK" = "CLEAR") => {
  await queueLaneReview(d, "fix-login", undefined);
  return laneAttest(d, verdict);
};

describe("patch-id receipt judgment", () => {
  test("an exact tip wins; another tip is covered only by the same patch content", () => {
    const older = receipt({ tip, patchId: patch, contentId: content });
    expect(pickLaneReceipt([older], tip, changed, otherContent)).toBe(older);
    expect(pickLaneReceipt([older], rebased, patch, content)).toBe(older);
    expect(pickLaneReceipt([older], rebased, changed, otherContent)).toBeUndefined();
    expect(pickLaneReceipt([older], rebased, undefined, undefined)).toBeUndefined();
    // The stable id ignores whitespace; the content id does not, so a whitespace-only edit is not covered.
    expect(pickLaneReceipt([older], rebased, patch, otherContent)).toBeUndefined();
  });

  test("a receipt written before contentId covers only its exact tip", () => {
    const legacy = receipt({ tip, patchId: patch });
    expect(pickLaneReceipt([legacy], tip, patch, content)).toBe(legacy);
    expect(pickLaneReceipt([legacy], rebased, patch, content)).toBeUndefined();
  });

  test("a BLOCK for the same patch beats a CLEAR, even at the exact tip", () => {
    const clear = receipt({ tip, patchId: patch, contentId: content, at: 99 });
    const block = receipt({ tip: other, verdict: "BLOCK", patchId: patch, contentId: content, at: 1 });
    const otherBlock = receipt({ tip: other, verdict: "BLOCK", patchId: patch, contentId: otherContent, at: 2 });
    expect(pickLaneReceipt([clear, block], rebased, patch, content)?.verdict).toBe("BLOCK");
    expect(pickLaneReceipt([clear, block], tip, patch, content)?.verdict).toBe("BLOCK");
    expect(pickLaneReceipt([clear, otherBlock], rebased, patch, content)?.verdict).toBe("CLEAR");
  });

  test("a legacy BLOCK without contentId still blocks a same-patch CLEAR", () => {
    const clear = receipt({ tip, patchId: patch, contentId: content, at: 99 });
    const legacy = receipt({ tip: other, verdict: "BLOCK", patchId: patch, at: 1 });
    expect(pickLaneReceipt([clear, legacy], rebased, patch, content)).toBe(legacy);
    expect(pickLaneReceipt([clear, legacy], tip, patch, content)).toBe(legacy);
  });
});

describe("patch-id lane receipts", () => {
  test("attestation records the reviewed diff and a rebase-only move keeps the CLEAR receipt", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    const written = d.store.laneReceipt("fix-login", tip);
    expect(written?.patchId).toBe(patch);
    expect(written?.reviewedTip).toBe(tip);

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

  test("a same-patch BLOCK cannot be cleared by moving only the SHA", async () => {
    const { d, repo } = await laneWorld();
    await attest(d, "BLOCK");
    repo.head = rebased;
    await expect(done(d, "fix-login")).rejects.toThrow("is BLOCK");
    const kept = await attest(d);
    expect(kept).toMatchObject({ verdict: "BLOCK", kept: true });
    expect(d.store.laneReceipt("fix-login", rebased)).toBeUndefined();
  });

  test("a same-patch BLOCK beats an exact-tip CLEAR after the SHA moves back", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    repo.head = rebased;
    await attest(d, "BLOCK");
    repo.head = tip;
    await expect(done(d, "fix-login")).rejects.toThrow("is BLOCK");
  });

  test("attest refuses a lane that committed after the review", async () => {
    const { d, repo } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    repo.head = other;
    delete repo.patchId;
    repo.diff = changedDiff;
    await expect(laneAttest(d)).rejects.toThrow("no saved review diff matches");
  });

  test("attest accepts a rebase that leaves the patch unchanged and records the reviewed tip", async () => {
    const { d, repo } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    repo.head = rebased;
    const result = await laneAttest(d);
    expect(result).toMatchObject({ verdict: "CLEAR", tip: rebased });
    const written = d.store.laneReceipt("fix-login", rebased);
    expect(written?.reviewedTip).toBe(tip);
    expect(written?.reviewedBase).toBe(base);
    expect(written?.patchId).toBe(patch);
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
  });

  test("attest refuses a rebase that changed the patch", async () => {
    const { d, repo } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    repo.head = rebased;
    delete repo.patchId;
    repo.diff = changedDiff;
    await expect(laneAttest(d)).rejects.toThrow("no saved review diff matches");
  });

  test("attest refuses when no reviewed diff exists", async () => {
    const { d } = await laneWorld();
    await expect(laneAttest(d)).rejects.toThrow("no reviewed diff is saved");
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

  test("done refuses a legacy BLOCK for the same patch even with an exact CLEAR", async () => {
    const { d } = await laneWorld();
    await attest(d);
    d.store.saveLaneReceipt(receipt({ tip: other, verdict: "BLOCK", patchId: patch, at: 99 }));
    await expect(done(d, "fix-login")).rejects.toThrow("is BLOCK");
  });

  test("the gate fails closed with an explicit error when git cannot inspect the lane diff", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    d.store.saveLaneReceipt(
      receipt({ tip: other, verdict: "BLOCK", patchId: changed, contentId: otherContent, at: 2 }),
    );
    repo.diffFails = "fatal: unable to read tree deadbeef";
    await expect(done(d, "fix-login")).rejects.toThrow("cannot inspect");
  });

  test("attest refuses a saved diff whose tip has no request or receipt record", async () => {
    const { d, repo } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    rmSync(jobPath(d.store.root, "fix-login", tip));
    repo.head = rebased;
    await expect(laneAttest(d)).rejects.toThrow("cannot be verified against git");
  });

  test("attest fails closed when git does not support patch-id --verbatim", async () => {
    const { d, repo } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    repo.patchIdVerbatimFails = "error: unknown option `verbatim'";
    await expect(laneAttest(d)).rejects.toThrow("does not support git patch-id --verbatim");
  });

  test("a receipt written before patch-id still gates its exact tip", async () => {
    const { d } = await laneWorld();
    d.store.saveLaneReceipt(receipt({ tip }));
    expect(d.store.laneReceipt("fix-login", tip)?.patchId).toBeUndefined();
    expect(await done(d, "fix-login")).toBeUndefined();
  });

  test("attest refuses a saved diff that changed only in whitespace", async () => {
    const { d, repo } = await laneWorld();
    delete repo.patchId;
    await queueLaneReview(d, "fix-login", undefined);
    repo.diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x =  1;\n";
    await expect(laneAttest(d)).rejects.toThrow("only in whitespace");
    expect(d.store.laneReceipt("fix-login", tip)).toBeUndefined();
  });

  test("attest refuses a saved diff that was edited away from what git produces", async () => {
    const { d } = await laneWorld();
    await queueLaneReview(d, "fix-login", undefined);
    const path = d.store.laneDiffPath("fix-login", tip);
    writeFileSync(path, `${readFileSync(path, "utf8")}+// edited after the queue\n`);
    await expect(laneAttest(d)).rejects.toThrow("not the diff git produces");
  });

  test("an exact CLEAR still gates a net-zero tip when another patch has a BLOCK", async () => {
    const { d, repo } = await laneWorld();
    await attest(d);
    d.store.saveLaneReceipt(
      receipt({ tip: other, verdict: "BLOCK", patchId: changed, contentId: otherContent, at: 2 }),
    );
    repo.diff = "";
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});
