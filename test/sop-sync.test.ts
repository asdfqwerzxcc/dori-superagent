import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { SopStore } from "../src/sop-store.ts";
import { syncGate } from "../src/sop-sync.ts";
import type { SopDef, SopReceipt } from "../src/sop-types.ts";
import type { Bundle } from "../src/store-types.ts";
import { cli } from "./board-fixture.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";
import { findRun, putSop, runIdOf, sopReceipts } from "./sop-fixture.ts";

const PR = { number: 7, url: "https://github.com/acme/fork/pull/7" };

const def = (): SopDef => ({
  id: "gate",
  title: "Gate",
  nodes: [
    { id: "work", kind: "agent" },
    { id: "approve", kind: "approval", prompt: "Approve?", bundle: "b-1", needs: ["work"] },
  ],
});

const bundle = (): Bundle => ({
  id: "b-1",
  title: "One",
  issue: null,
  repo: "acme/fork",
  members: [],
  branch: "bundle/b-1",
  pr: PR,
  status: "open",
});

async function started(d: Deps): Promise<string> {
  putSop(d, def());
  d.store.saveBundle(bundle());
  return runIdOf((await cli(d, ["sop", "run", "gate", "--bundle", "b-1"])).out);
}

const storeOf = (d: Deps): SopStore => new SopStore(d.store.root);

const reviews = (w: World, list: unknown[]) => {
  w.gh = (argv) =>
    argv[0] === "pr" && argv[1] === "view"
      ? { code: 0, stdout: JSON.stringify({ reviews: list }) }
      : { code: 1, stdout: "" };
};

const receipt = (d: Deps): SopReceipt => {
  const names = sopReceipts(d);
  expect(names).toHaveLength(1);
  return JSON.parse(readFileSync(join(d.store.root, "receipts", names[0]!), "utf8")) as SopReceipt;
};

describe("syncGate", () => {
  test("an approving review completes the approval node and writes a source-mr receipt", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    reviews(w, [{ state: "APPROVED", author: { login: "lee" }, body: "LGTM" }]);
    const outcome = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(outcome.code).toBe(0);
    expect(outcome.lines[0]).toContain(`SYNC ${runId} approve by=lee`);
    const run = findRun(d, runId);
    expect(run.gate).toMatchObject({ state: "approved", by: "lee", note: "LGTM" });
    expect(run.nodes["approve"]).toMatchObject({ state: "done" });
    expect(receipt(d)).toMatchObject({ decision: "approve", by: "lee", source: "mr", mr: PR.url });
  });

  test("a change request rejects with the review body as the reason", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    reviews(w, [
      { state: "APPROVED", author: { login: "lee" }, body: "nice" },
      { state: "CHANGES_REQUESTED", author: { login: "kim" }, body: "needs tests" },
    ]);
    const outcome = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(outcome.code).toBe(0);
    expect(outcome.lines[0]).toContain(`SYNC ${runId} reject by=kim`);
    expect(outcome.lines[1]).toBe("reason: needs tests");
    const run = findRun(d, runId);
    expect(run.gate).toMatchObject({ state: "rejected", by: "kim", reason: "needs tests" });
    expect(run.nodes["approve"]?.state).toBe("failed");
    expect(receipt(d)).toMatchObject({ decision: "reject", reason: "needs tests", source: "mr" });
  });

  test("a decided gate is compared: in sync exits 0, a mismatch exits 1 without rewriting it", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    await cli(d, ["sop", "gate", "approve", runId, "--by", "lee"]);
    reviews(w, [{ state: "APPROVED", author: { login: "kim" }, body: "" }]);
    const inSync = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(inSync.code).toBe(0);
    expect(inSync.lines).toEqual([`SYNC ${runId} gate=approved mr=approved (in sync)`]);
    reviews(w, [{ state: "CHANGES_REQUESTED", author: { login: "kim" }, body: "no" }]);
    const outcome = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(outcome.code).toBe(1);
    expect(outcome.lines).toEqual([`MISMATCH ${runId} gate=approved mr=changes-requested`]);
    expect(findRun(d, runId).gate?.state).toBe("approved");
  });

  test("an undecided review leaves the gate pending and writes no receipt", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    reviews(w, [{ state: "COMMENTED", author: { login: "lee" }, body: "hm" }]);
    const outcome = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(outcome.lines).toEqual([`SYNC ${runId} pending mr=no-decision`]);
    expect(findRun(d, runId).gate?.state).toBe("pending");
    expect(sopReceipts(d)).toEqual([]);
  });

  test("a review that names no author refuses, and --by supplies the fallback", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    w.reviewer = (argv) => {
      if (argv[1]?.endsWith("/approvals")) return { code: 0, stdout: JSON.stringify({ approved_by: [] }) };
      return {
        code: 0,
        stdout: JSON.stringify({ detailed_merge_status: "requested_changes", reviewers: [] }),
      };
    };
    await expect(syncGate(d, storeOf(d), runId, "glab", undefined)).rejects.toThrow("does not name its author");
    const outcome = await syncGate(d, storeOf(d), runId, "glab", "lee");
    expect(outcome.code).toBe(0);
    expect(outcome.lines[0]).toContain(`SYNC ${runId} reject by=lee`);
    expect(outcome.lines[1]).toBe(`reason: changes requested on acme/fork#7`);
    expect(receipt(d)).toMatchObject({ decision: "reject", by: "lee", reason: "changes requested on acme/fork#7" });
  });

  test("a dismissed review leaves the gate pending", async () => {
    const { w, d } = setup();
    const runId = await started(d);
    reviews(w, [
      { state: "APPROVED", author: { login: "lee" }, body: "" },
      { state: "DISMISSED", author: { login: "lee" }, body: "" },
    ]);
    const outcome = await syncGate(d, storeOf(d), runId, "gh", undefined);
    expect(outcome.lines).toEqual([`SYNC ${runId} pending mr=no-decision`]);
    expect(findRun(d, runId).gate?.state).toBe("pending");
    expect(sopReceipts(d)).toEqual([]);
  });
});
