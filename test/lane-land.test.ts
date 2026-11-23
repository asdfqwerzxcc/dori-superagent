import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { mergeLane } from "../src/lane-land.ts";
import type { Lane } from "../src/store-types.ts";
import { href } from "./fake.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tipA = "b".repeat(40);
const tipB = "c".repeat(40);
const repoName = "asdfqwerzxcc/dori-design-system";
const url = `https://github.com/${repoName}/pull/7`;

function laneFixture(tip = tipA) {
  const { w, d } = setup();
  const repoPath = mkdtempSync(join(tmpdir(), "dori-lane-land-"));
  const repo: Repo = {
    head: base,
    mergeBase: base,
    remotes: { origin: `https://github.com/${repoName}.git` },
    heads: { [repoPath]: tip },
  };
  fakeGit(w, repo);
  const lane: Lane = {
    key: "alpha",
    sessionRef: href("w1:p9"),
    paneId: "w1:p9",
    tabId: "w1:t1",
    brief: join(d.store.root, "brief.md"),
    cwd: repoPath,
    worktree: repoPath,
    repo: repoPath,
    baseSha: base,
    tipSha: tip,
    status: "ready",
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    final: { text: "Lane alpha ready", evidence: ["https://example.test/alpha"], at: 2 },
    log: [],
  };
  d.store.saveLane(lane);
  return { w, d, repo, repoPath, lane };
}

function receiptAt(d: Deps, tip: string): void {
  d.store.saveLaneReceipt({
    lane: "alpha",
    verdict: "CLEAR",
    base,
    tip,
    brief: "Land the design lane through its PR.",
    reviewer: "reviewer-alpha",
    at: 3,
    summary: "",
  });
}

describe("lane landing", () => {
  test("a CLEAR receipt pushes, creates the PR, merges it as a merge commit and deletes the branch", async () => {
    const { w, d, repoPath } = laneFixture();
    receiptAt(d, tipA);
    w.gh = (argv) => {
      if (argv[0] === "pr" && argv[1] === "view")
        return { code: 1, stdout: "no pull requests found for branch lane/alpha" };
      if (argv[0] === "pr" && argv[1] === "create") return { code: 0, stdout: `${url}\n` };
      if (argv[0] === "pr" && argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: `unhandled gh ${argv.join(" ")}` };
    };

    const dry = await mergeLane(d, "alpha", { dryRun: true });
    expect(dry.join("\n")).toContain(`repo=${repoName}`);
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);

    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toBe(
      `MERGED lane/alpha head=${tipA.slice(0, 12)} repo=${repoName} pr=#7 ${url} branch=deleted`,
    );

    const push = w.calls.find((call) => call.cmd === "git" && call.argv.includes(`${tipA}:refs/heads/lane/alpha`));
    expect(push?.argv).toEqual(["-C", repoPath, "push", "origin", `${tipA}:refs/heads/lane/alpha`]);

    const create = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "create");
    expect(create?.argv).toContain("--repo");
    expect(create?.argv).toContain(repoName);
    expect(create?.argv).toContain("--base");
    expect(create?.argv).toContain("main");
    expect(create?.argv).toContain("--head");
    expect(create?.argv).toContain("lane/alpha");
    expect(create?.argv).toContain("Lane alpha ready");
    expect(create?.argv.join("\n")).toContain("https://example.test/alpha");

    const merge = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "merge");
    expect(merge?.argv).toContain("--merge");
    expect(merge?.argv).toContain("--match-head-commit");
    expect(merge?.argv).toContain(tipA);
    expect(merge?.argv).not.toContain("--squash");

    const del = w.calls.find((call) => call.cmd === "git" && call.argv.includes("--delete"));
    expect(del?.argv).toEqual(["-C", repoPath, "push", "origin", "--delete", "lane/alpha"]);
  });

  test("targets the lane repository's fork, never an upstream origin", async () => {
    const { w, d, repo } = laneFixture();
    receiptAt(d, tipA);
    repo.remotes = {
      origin: "https://github.com/sisyphuslabs/dori-superagent.git",
      fork: "https://github.com/asdfqwerzxcc/dori-superagent.git",
    };
    const out = (await mergeLane(d, "alpha", { dryRun: true })).join("\n");
    expect(out).toContain("repo=asdfqwerzxcc/dori-superagent");
    expect(out).toContain("push fork lane/alpha");
    expect(out).not.toContain("sisyphuslabs");
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
  });

  test("refuses without a receipt before any push or PR", async () => {
    const { w, d } = laneFixture();
    await expect(mergeLane(d, "alpha")).rejects.toThrow("no review receipt");
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);
  });

  test("refuses a receipt at another sha as stale", async () => {
    const { w, d } = laneFixture(tipB);
    receiptAt(d, tipA);
    const failure: unknown = await mergeLane(d, "alpha").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("stale sha");
    expect((failure as Error).message).toContain(tipA.slice(0, 12));
    expect((failure as Error).message).toContain(tipB.slice(0, 12));
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);
  });
});
