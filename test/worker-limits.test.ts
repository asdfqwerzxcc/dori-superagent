import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prompt, promptsDir } from "../src/harness.ts";
import { ceilingText, CEILING_VARS, LANE_CEILING, REVIEW_CEILING, wallText } from "../src/worker-limits.ts";

describe("worker ceilings", () => {
  test("the constants render as the prompt text", () => {
    expect(ceilingText(REVIEW_CEILING)).toBe("2 hours or 250000 tokens");
    expect(ceilingText(LANE_CEILING)).toBe("3 hours or 400000 tokens");
    expect(wallText(REVIEW_CEILING)).toBe("2 hours");
  });

  test("review and lane prompts state the ceiling and the stop behavior", () => {
    const review = prompt("review.md", CEILING_VARS);
    expect(review).toContain("Review ceiling: 2 hours or 250000 tokens");
    expect(review).not.toContain("{{reviewCeiling}}");
    expect(review).toContain("A partial review is never CLEAR");

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
    expect(laneReview).toContain("Review ceiling: 2 hours or 250000 tokens");
    expect(laneReview).not.toContain("{{");

    const lane = prompt("lane-footer.md", { key: "k", dori: "dori", ...CEILING_VARS });
    expect(lane).toContain("A lane stops at 3 hours or 400000 tokens");
    expect(lane).toContain("### Pause safely");
    expect(lane).toContain("$DORI_HOME/briefs/k.state.md");
    expect(lane).toContain("**Goal**");
    expect(lane).toContain("**Prohibitions**");
  });

  test("duty and review-lane read the ceiling from the constants, never a copied number", () => {
    const duty = prompt("duty.md", { dori: "dori", ...CEILING_VARS });
    expect(duty).toContain(`when one has run ${wallText(REVIEW_CEILING)}, tell the lead once`);
    expect(duty).not.toContain("{{");
    const rawDuty = readFileSync(join(promptsDir(), "duty.md"), "utf8");
    const rawLaneReview = readFileSync(join(promptsDir(), "review-lane.md"), "utf8");
    expect(rawDuty).not.toContain("2 hours");
    expect(rawDuty).toContain("{{reviewWall}}");
    expect(rawLaneReview).not.toContain("2 hours");
    expect(rawLaneReview).toContain("{{reviewCeiling}}");
  });
});
