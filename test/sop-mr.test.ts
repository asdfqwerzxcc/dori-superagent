import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
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
    { id: "ship", kind: "script", script: "echo ship", needs: ["approve"] },
  ],
});

const bundle = (pr: Bundle["pr"] = PR): Bundle => ({
  id: "b-1",
  title: "One",
  issue: null,
  repo: "acme/fork",
  members: [{ lane: "alpha", sha: "a".repeat(40), verdict: "CLEAR", reviewer: "reviewer" }],
  branch: "bundle/b-1",
  pr,
  status: "open",
});

async function started(d: Deps): Promise<string> {
  putSop(d, def());
  const runId = runIdOf((await cli(d, ["sop", "run", "gate", "--bundle", "b-1"])).out);
  await cli(d, ["sop", "step", runId, "work", "--state", "running"]);
  await cli(d, ["sop", "step", runId, "work", "--state", "done", "--note", "3 files"]);
  return runId;
}

const stubGh = (w: World, reviews: unknown[], comment = "https://github.com/acme/fork/pull/7#issuecomment-9") => {
  w.gh = (argv) => {
    if (argv[0] === "pr" && argv[1] === "view" && argv.includes("reviews"))
      return { code: 0, stdout: JSON.stringify({ reviews }) };
    if (argv[0] === "pr" && argv[1] === "view") return { code: 0, stdout: JSON.stringify({ comments: [] }) };
    if (argv[0] === "pr" && argv[1] === "comment") return { code: 0, stdout: `${comment}\n` };
    return { code: 1, stdout: "" };
  };
};

const ghCalls = (w: World): readonly string[][] => w.calls.filter((c) => c.cmd === "gh").map((c) => [...c.argv]);

const receipt = (d: Deps): SopReceipt => {
  const names = sopReceipts(d);
  expect(names).toHaveLength(1);
  return JSON.parse(readFileSync(join(d.store.root, "receipts", names[0]!), "utf8")) as SopReceipt;
};

describe("gate show posts to the MR", () => {
  test("posts the rationale as a comment and prints its URL", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, []);
    const runId = await started(d);
    const out = await cli(d, ["sop", "gate", "show", runId, "approve"]);
    expect(out.code).toBe(0);
    expect(out.out.split("\n")).toEqual([
      `GATE ${runId} sop=gate node=approve state=pending`,
      "bundle: b-1",
      "repo: acme/fork",
      "pr: #7 https://github.com/acme/fork/pull/7",
      "post: https://github.com/acme/fork/pull/7#issuecomment-9",
    ]);
    const call = ghCalls(w).find((argv) => argv[1] === "comment")!;
    expect(call.slice(0, 4)).toEqual(["pr", "comment", "7", "--repo"]);
    expect(call).toContain("acme/fork");
    const body = call[call.indexOf("--body") + 1]!;
    expect(body).toContain(`dori:sop-gate run=${runId} node=approve`);
    expect(body).toContain("| `work` | agent | done | 3 files |");
    expect(body).toContain("`alpha`");
    expect(body).toContain(`dori sop sync ${runId}`);
  });

  test("skips posting when the bundle has no MR or is missing, without calling gh", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle(null));
    w.gh = () => {
      throw new Error("gh must not run");
    };
    const runId = await started(d);
    const noPr = await cli(d, ["sop", "gate", "show", runId, "approve"]);
    expect(noPr.code).toBe(0);
    expect(noPr.out).toContain(`post: skipped (bundle b-1 has no MR; run: dori bundle land b-1)`);

    const ghost = setup();
    putSop(ghost.d, { ...def(), nodes: def().nodes.map((n) => (n.id === "approve" ? { ...n, bundle: "ghost" } : n)) });
    const ghostRun = runIdOf((await cli(ghost.d, ["sop", "run", "gate", "--bundle", "b-1"])).out);
    const missing = await cli(ghost.d, ["sop", "gate", "show", ghostRun, "approve"]);
    expect(missing.out).toContain("post: skipped (bundle ghost is missing)");
  });

  test("--provider glab posts with glab mr note", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    const calls: string[][] = [];
    w.reviewer = (argv) => {
      calls.push([...argv]);
      if (argv[0] === "api") return { code: 0, stdout: "[]" };
      return { code: 0, stdout: "" };
    };
    const runId = await started(d);
    const out = await cli(d, ["sop", "gate", "show", runId, "approve", "--provider", "glab"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("post: glab acme/fork#7");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "projects/acme%2Ffork/merge_requests/7/notes?per_page=100"]);
    const note = calls.find((argv) => argv[0] === "mr" && argv[1] === "note")!;
    expect(note.slice(0, 3)).toEqual(["mr", "note", "7"]);
    expect(note).toContain("acme/fork");
  });
});

describe("sop sync reads the MR review", () => {
  test("an approving review completes the approval node with the same receipt", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, [
      { state: "COMMENTED", author: { login: "lee" }, body: "looks close" },
      { state: "APPROVED", author: { login: "lee" }, body: "LGTM" },
    ]);
    const runId = await started(d);
    const out = await cli(d, ["sop", "sync", runId]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`SYNC ${runId} approve by=lee receipt=${join(d.store.root, "receipts", "sop-")}`);
    expect(out.out).toContain(`mr=${PR.url}`);
    const run = findRun(d, runId);
    expect(run.gate).toMatchObject({ state: "approved", by: "lee", note: "LGTM" });
    expect(run.nodes["approve"]).toMatchObject({ state: "done" });
    expect(receipt(d)).toMatchObject({
      kind: "sop-gate",
      run: runId,
      bundle: "b-1",
      node: "approve",
      decision: "approve",
      by: "lee",
      note: "LGTM",
      source: "mr",
      mr: PR.url,
    });
  });

  test("a change request rejects the gate with the reviewer's reason", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, [
      { state: "APPROVED", author: { login: "lee" }, body: "nice" },
      { state: "CHANGES_REQUESTED", author: { login: "kim" }, body: "needs tests" },
    ]);
    const runId = await started(d);
    const out = await cli(d, ["sop", "sync", runId]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`SYNC ${runId} reject by=kim`);
    expect(out.out).toContain("reason: needs tests");
    expect(findRun(d, runId).gate).toMatchObject({ state: "rejected", by: "kim", reason: "needs tests" });
    expect(findRun(d, runId).nodes["approve"]?.state).toBe("failed");
    expect(receipt(d)).toMatchObject({ decision: "reject", by: "kim", reason: "needs tests", source: "mr" });
  });

  test("the latest review per author wins", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, [
      { state: "CHANGES_REQUESTED", author: { login: "lee" }, body: "one more", submittedAt: "2026-11-21T11:00:00Z" },
      { state: "APPROVED", author: { login: "lee" }, body: "", submittedAt: "2026-11-21T10:00:00Z" },
    ]);
    const runId = await started(d);
    expect((await cli(d, ["sop", "sync", runId])).out).toContain("reject by=lee");
    expect(findRun(d, runId).gate?.reason).toBe("one more");

    const second = setup();
    second.d.store.saveBundle(bundle());
    stubGh(second.w, [
      { state: "CHANGES_REQUESTED", author: { login: "lee" }, body: "fix" },
      { state: "APPROVED", author: { login: "lee" }, body: "fixed" },
    ]);
    const other = await started(second.d);
    expect((await cli(second.d, ["sop", "sync", other])).out).toContain("approve by=lee");
    expect(findRun(second.d, other).gate?.state).toBe("approved");
  });

  test("no decisive review leaves the gate pending", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, [{ state: "COMMENTED", author: { login: "lee" }, body: "hm" }]);
    const runId = await started(d);
    const out = await cli(d, ["sop", "sync", runId]);
    expect(out.out).toBe(`SYNC ${runId} pending mr=no-decision`);
    expect(findRun(d, runId).gate?.state).toBe("pending");
    expect(sopReceipts(d)).toEqual([]);
  });

  test("a decided gate is compared, never rewritten; a mismatch exits 1", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    stubGh(w, [{ state: "APPROVED", author: { login: "lee" }, body: "" }]);
    const runId = await started(d);
    await cli(d, ["sop", "gate", "approve", runId, "--by", "lee"]);
    expect((await cli(d, ["sop", "sync", runId])).out).toBe(`SYNC ${runId} gate=approved mr=approved (in sync)`);

    stubGh(w, [{ state: "CHANGES_REQUESTED", author: { login: "kim" }, body: "actually no" }]);
    const mismatch = await cli(d, ["sop", "sync", runId]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).toBe(`MISMATCH ${runId} gate=approved mr=changes-requested`);
    expect(findRun(d, runId).gate?.state).toBe("approved");
  });

  test("refuses when the bundle has no MR", async () => {
    const { d } = setup();
    d.store.saveBundle(bundle(null));
    const runId = await started(d);
    await expect(cli(d, ["sop", "sync", runId])).rejects.toThrow("has no MR");
  });

  test("--provider glab reads approvals and requested changes from glab api", async () => {
    const { w, d } = setup();
    d.store.saveBundle(bundle());
    w.reviewer = (argv) => {
      if (argv[1]?.endsWith("/approvals")) return { code: 0, stdout: JSON.stringify({ approved_by: [] }) };
      if (argv[1] !== undefined)
        return {
          code: 0,
          stdout: JSON.stringify({
            detailed_merge_status: "requested_changes",
            reviewers: [{ username: "kim", state: "requested_changes" }],
          }),
        };
      return { code: 1, stdout: "" };
    };
    const runId = await started(d);
    const out = await cli(d, ["sop", "sync", runId, "--provider", "glab"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`SYNC ${runId} reject by=kim`);
    expect(out.out).toContain("reason: changes requested on acme/fork#7");
    expect(findRun(d, runId).gate).toMatchObject({ state: "rejected", by: "kim" });
  });
});
