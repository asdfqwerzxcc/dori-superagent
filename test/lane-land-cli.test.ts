import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../src/cli.ts";
import { laneFixture, receiptAt, tipA } from "./lane-land-setup.ts";

describe("merge CLI dispatch", () => {
  test("main merge lane/<key> --dry-run prints the lane plan", async () => {
    const { d } = laneFixture();
    receiptAt(d, tipA);
    const log = spyOn(console, "log").mockImplementation(() => {});
    let code = -1;
    try {
      code = await main(["merge", "lane/alpha", "--dry-run"], d);
    } catch (e) {
      log.mockRestore();
      throw e;
    }
    const out = log.mock.calls.map((call) => call.join(" ")).join("\n");
    log.mockRestore();
    expect(code).toBe(0);
    expect(out).toContain("LANE_MERGE alpha (dry run)");
    expect(out).toContain("LANE_MERGE_DRY_RUN alpha");
  });

  test("main merge <key> --bundle is refused", async () => {
    const { d } = laneFixture();
    await expect(main(["merge", "alpha", "--bundle", "b"], d)).rejects.toThrow("--bundle needs a PR id");
  });
});
