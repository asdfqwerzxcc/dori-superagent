import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ready, startLane } from "../src/lanes.ts";
import { review } from "../src/review-pr.ts";
import { jobPath } from "../src/review-job.ts";
import { queueLaneReview } from "../src/review-queue.ts";
import type { World } from "./fake.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

function gh(w: World, headRefName: string, prDiff: string, opts: { diffFails?: boolean } = {}): void {
  w.gh = (argv) => {
    if (argv[1] === "view" && argv.includes("headRefOid"))
      return { code: 0, stdout: JSON.stringify({ headRefOid: tip }) };
    if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefName, title: "t", body: "b" }) };
    if (argv[1] === "diff")
      return opts.diffFails === true
        ? { code: 1, stdout: "", stderr: "gh: server error" }
        : { code: 0, stdout: prDiff };
    return { code: 1, stdout: "" };
  };
}

function capture(w: World): () => string {
  let text = "";
  w.reviewer = (_argv, options) => {
    text = String(options?.stdin ?? "");
    return { code: 0, stdout: "VERDICT: CLEAR" };
  };
  return () => text;
}

const ghDiffCalls = (w: World): number => w.calls.filter((call) => call.cmd === "gh" && call.argv[1] === "diff").length;

describe("lane review prompt", () => {
  test("a lane PR reviews the saved lane diff and the brief without calling gh pr diff", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "done", ["file:///x"]);
    repo.head = tip;
    await queueLaneReview(d, "fix-login", undefined);
    const promptText = capture(w);
    gh(w, "lane/fix-login", "", { diffFails: true });

    expect(await review(d, "o/r#7")).toEqual({ verdict: "CLEAR", sha: tip });
    const text = promptText();
    expect(text).toContain("Review the work of lane fix-login");
    expect(text).toContain("Fix the flaky login test.");
    expect(text).toContain("+export const x = 1;");
    expect(text).not.toContain("{{");
    expect(ghDiffCalls(w)).toBe(0);
  });

  test("a PR that is not a lane stays on the ordinary reviewer and the server diff", async () => {
    const { w, d } = setup();
    fakeGit(w, { head: base, mergeBase: base, diff });
    const promptText = capture(w);
    gh(w, "feature/login", "diff --git a/src/y.ts b/src/y.ts\n+PR DIFF\n");

    expect(await review(d, "o/r#8")).toEqual({ verdict: "CLEAR", sha: tip });
    const text = promptText();
    expect(text).toContain("Review pull request o/r#8");
    expect(text).toContain("+PR DIFF");
    expect(text).not.toContain("Review the work of lane");
    expect(ghDiffCalls(w)).toBe(1);
  });

  test("a lane branch with no saved diff at its head falls back to the ordinary reviewer", async () => {
    const { w, d, brief } = setup();
    fakeGit(w, { head: base, mergeBase: base, diff });
    await startLane(d, "fix-login", brief, { group: "w1" });
    const promptText = capture(w);
    gh(w, "lane/fix-login", "diff --git a/src/z.ts b/src/z.ts\n+NO QUEUE\n");

    await review(d, "o/r#9");
    const text = promptText();
    expect(text).toContain("Review pull request o/r#9");
    expect(text).toContain("+NO QUEUE");
    expect(text).not.toContain("Review the work of lane");
  });

  test("a missing request uses the saved diff's merge-base, not the lane's start sha", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "done", ["file:///x"]);
    repo.head = tip;
    await queueLaneReview(d, "fix-login", undefined);
    rmSync(jobPath(d.store.root, "fix-login", tip));
    repo.mergeBase = "e".repeat(40);
    const promptText = capture(w);
    gh(w, "lane/fix-login", "diff --git a/src/x.ts b/src/x.ts\n+WRONG\n");

    await review(d, "o/r#10");
    expect(promptText()).toContain(`(base ${"e".repeat(40)})`);
  });

  test("a long brief keeps the lane contract after truncation", async () => {
    const { w, d } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const longBrief = join(d.store.root, "long-brief.md");
    writeFileSync(longBrief, `LONG-BRIEF-MARKER\n${"x".repeat(14_000)}\n`);
    await startLane(d, "long-lane", longBrief, { group: "w1" });
    await ready(d, "long-lane", "done", ["file:///x"]);
    repo.head = tip;
    await queueLaneReview(d, "long-lane", undefined);
    const promptText = capture(w);
    gh(w, "lane/long-lane", "diff --git a/src/x.ts b/src/x.ts\n+WRONG\n");

    await review(d, "o/r#11");
    const text = promptText();
    expect(text).toContain("LONG-BRIEF-MARKER");
    expect(text).toContain("the lane contract follows unchanged");
    expect(text).toContain("**Prohibitions**");
    expect(text).toContain("### Pause safely");
  });
});
