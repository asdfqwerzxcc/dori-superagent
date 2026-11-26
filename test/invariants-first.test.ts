import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prompt } from "../src/harness.ts";
import { CEILING_VARS } from "../src/worker-limits.ts";

const TRIGGER =
  "Changes that need invariants are triggered by `DIFFICULTY: D3|D4`, an `## Invariants` section, or a high category " +
  "(`deep-high`, `ultrabrain`, `architect`).";

const FLASH =
  "**flash/default on D3+** (a `DIFFICULTY: D3|D4` brief or an `## Invariants` section, with no high category named): " +
  "(a) list each invariant with its failure mode; (b) add one test per invariant and capture the failing output on the " +
  "pre-fix code; (c) fix only what those tests demand; (d) report per invariant the test name and the before/after output.";

const HIGH =
  "**deep-high / ultrabrain / architect** (even when the brief is D3+): no procedure is enforced; invariants and their " +
  "evidence are expected deliverables. Document each invariant and cover it with a test. The gate checks that outcome " +
  "only and does not block for a missed step.";

const KILL =
  "never kill host-wide processes: `taskkill /IM`, `pkill`, and `kill -9` against every instance are forbidden. " +
  "End only a target whose identity (pid and OS start time) you have confirmed.";

const MIRROR_HEAD = "A D3+ change on the flash/default path";

const MIRROR_TAIL =
  "without per-invariant failing-first evidence — one test per invariant, the captured failing output on the pre-fix " +
  "code, and the test name with before/after output in the report — is a HIGH finding (missing tests for changed " +
  "behaviour, hardened): `VERDICT: BLOCK`.";

const REVIEW_TRIGGER =
  "(`DIFFICULTY: D3|D4` in the PR body, or an `## Invariants` section, with no high category named)";

const DOC_BLOCK =
  "리뷰 게이트는 flash/default D3+에서 실패-선행 증거가 없으면 HIGH로 보고 `VERDICT: BLOCK`하고, 상위 카테고리는 결과만 검사한다";

const LANE_TRIGGER =
  "(`DIFFICULTY: D3|D4` in the lane brief, or an `## Invariants` section, with no high category named)";

const MIRROR_HIGH =
  "For the high categories (`deep-high`, `ultrabrain`, `architect`) apply an outcome check only for high categories: " +
  "the invariants are documented and each is covered by a test; missing documentation or an uncovered invariant is a " +
  "HIGH finding, and a missed failing-first step is not.";

const ROOT = resolve(import.meta.dir, "..");

describe("invariants-first rule (D3+)", () => {
  test("the lane footer states both branches and the kill prohibition", () => {
    const lane = prompt("lane-footer.md", { key: "k", dori: "dori", ...CEILING_VARS });
    expect(lane).toContain("### Invariants (D3+)");
    expect(lane).toContain(TRIGGER);
    expect(lane).toContain(FLASH);
    expect(lane).toContain(HIGH);
    expect(lane).toContain("### Prohibitions");
    expect(lane).toContain(KILL);
    expect(lane).not.toContain("{{");
  });

  test("both review prompts mirror the whole check and the outcome-only branch", () => {
    const review = prompt("review.md", {
      pr: "owner/repo#1",
      sha: "abc",
      title: "t",
      diff: "d",
      ...CEILING_VARS,
    });
    expect(review).toContain(MIRROR_HEAD);
    expect(review).toContain(REVIEW_TRIGGER);
    expect(review).toContain(MIRROR_TAIL);
    expect(review).toContain(MIRROR_HIGH);

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
    expect(laneReview).toContain(MIRROR_HEAD);
    expect(laneReview).toContain(LANE_TRIGGER);
    expect(laneReview).toContain(MIRROR_TAIL);
    expect(laneReview).toContain(MIRROR_HIGH);
    expect(laneReview).not.toContain("{{");
  });

  test("docs/workflow.md pins both branches, the BLOCK outcome and every kill example", () => {
    const doc = readFileSync(join(ROOT, "docs", "workflow.md"), "utf8");
    expect(doc).toContain("### 불변조건 우선 (D3+)");
    expect(doc).toContain(TRIGGER);
    expect(doc).toContain(FLASH);
    expect(doc).toContain(HIGH);
    expect(doc).toContain(DOC_BLOCK);
    expect(doc).toContain("### 호스트 전역 프로세스 킬 금지");
    expect(doc).toContain("`taskkill /IM`");
    expect(doc).toContain("`pkill`");
    expect(doc).toContain("`kill -9 <all>`");
    expect(doc).toContain("taskkill //F //IM bun.exe");
  });
});
