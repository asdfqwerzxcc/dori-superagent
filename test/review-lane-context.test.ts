import { describe, expect, test } from "bun:test";
import { ready, startLane } from "../src/lanes.ts";
import { review } from "../src/review-pr.ts";
import { queueLaneReview } from "../src/review-queue.ts";
import type { World } from "./fake.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

function gh(w: World, headRefName: string, prDiff: string): void {
  w.gh = (argv) => {
    if (argv[1] === "view" && argv.includes("headRefOid"))
      return { code: 0, stdout: JSON.stringify({ headRefOid: tip }) };
    if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefName, title: "t", body: "b" }) };
    if (argv[1] === "diff") return { code: 0, stdout: prDiff };
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

describe("lane review prompt", () => {
  test("a lane PR reviews the saved lane diff and the brief, not the server PR diff", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "done", ["file:///x"]);
    repo.head = tip;
    await queueLaneReview(d, "fix-login", undefined);
    const promptText = capture(w);
    gh(w, "lane/fix-login", "diff --git a/src/x.ts b/src/x.ts\n+WRONG\n");

    expect(await review(d, "o/r#7")).toEqual({ verdict: "CLEAR", sha: tip });
    const text = promptText();
    expect(text).toContain("Review the work of lane fix-login");
    expect(text).toContain("Fix the flaky login test.");
    expect(text).toContain("+export const x = 1;");
    expect(text).not.toContain("+WRONG");
    expect(text).not.toContain("{{");
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
});
