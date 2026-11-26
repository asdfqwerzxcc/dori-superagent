import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prompt } from "../src/harness.ts";
import { CEILING_VARS } from "../src/worker-limits.ts";

const RULE =
  "When the brief declares `DIFFICULTY: D3|D4` or carries an `## Invariants` section, this lane works invariants-first: " +
  "(a) list each invariant with its failure mode; (b) add one test per invariant and capture the failing output on the " +
  "pre-fix code; (c) fix only what those tests demand; (d) report per invariant the test name and the before/after output.";

const MIRROR =
  "A D3+ change (`DIFFICULTY: D3|D4` in the brief or PR body, or an `## Invariants` section) without per-invariant " +
  "failing-first evidence — one test per invariant, the captured failing output on the pre-fix code, and the test name " +
  "with before/after output in the report — is a HIGH finding (missing tests for changed behaviour, hardened): " +
  "`VERDICT: BLOCK`.";

const ROOT = resolve(import.meta.dir, "..");

describe("invariants-first rule (D3+)", () => {
  test("the lane footer states the conditional rule", () => {
    const lane = prompt("lane-footer.md", { key: "k", dori: "dori", ...CEILING_VARS });
    expect(lane).toContain("### Invariants (D3+)");
    expect(lane).toContain(RULE);
    expect(lane).not.toContain("{{");
  });

  test("both review prompts mirror the rule as a BLOCK", () => {
    const review = prompt("review.md", {
      pr: "owner/repo#1",
      sha: "abc",
      title: "t",
      diff: "d",
      ...CEILING_VARS,
    });
    expect(review).toContain(MIRROR);

    const laneReview = prompt("review-lane.md", {
      key: "k",
      tip: "t",
      base: "b",
      brief: "brief",
      diff: "d",
      diffPath: "p",
      checkout: "c",
      ...CEILING_VARS,
    });
    expect(laneReview).toContain(MIRROR);
    expect(laneReview).not.toContain("{{");
  });

  test("docs/workflow.md documents the rule beside the brief contract with the same wording", () => {
    const doc = readFileSync(join(ROOT, "docs", "workflow.md"), "utf8");
    expect(doc).toContain("### 불변조건 우선 (D3+)");
    expect(doc).toContain(RULE);
    expect(doc).toContain("`prompts/lane-footer.md`");
  });
});
