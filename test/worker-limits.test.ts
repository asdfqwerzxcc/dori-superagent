import { describe, expect, test } from "bun:test";
import { prompt } from "../src/harness.ts";
import { ceilingText, CEILING_VARS, LANE_CEILING, REVIEW_CEILING } from "../src/worker-limits.ts";

describe("worker ceilings", () => {
  test("the constants render as the prompt text", () => {
    expect(ceilingText(REVIEW_CEILING)).toBe("2 hours or 250000 tokens");
    expect(ceilingText(LANE_CEILING)).toBe("3 hours or 400000 tokens");
  });

  test("review and lane prompts state the ceiling and the stop behavior", () => {
    const review = prompt("review.md", CEILING_VARS);
    expect(review).toContain("Review ceiling: 2 hours or 250000 tokens");
    expect(review).not.toContain("{{reviewCeiling}}");
    expect(review).toContain("A partial review is never CLEAR");

    const lane = prompt("lane-footer.md", { key: "k", dori: "dori", ...CEILING_VARS });
    expect(lane).toContain("A lane stops at 3 hours or 400000 tokens");
    expect(lane).toContain("### Pause safely");
    expect(lane).toContain("$DORI_HOME/briefs/k.state.md");
    expect(lane).toContain("**Goal**");
    expect(lane).toContain("**Prohibitions**");
  });
});
