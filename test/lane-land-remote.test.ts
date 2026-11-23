import { describe, expect, test } from "bun:test";
import { mergeLane } from "../src/lane-land.ts";
import { base, laneFixture, laneGh, receiptAt, tipA } from "./lane-land-setup.ts";

describe("lane landing remotes and cleanup", () => {
  test("targets the lane repository's fork, never an upstream origin", async () => {
    const { w, d, repo, repoPath } = laneFixture();
    receiptAt(d, tipA);
    repo.remotes = {
      origin: "https://github.com/sisyphuslabs/dori-superagent.git",
      fork: "https://github.com/asdfqwerzxcc/dori-superagent.git",
    };
    laneGh(w);
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain("repo=asdfqwerzxcc/dori-superagent");

    const push = w.calls.find((call) => call.cmd === "git" && call.argv.includes(`${tipA}:refs/heads/lane/alpha`));
    expect(push?.argv).toEqual(["-C", repoPath, "push", "fork", `${tipA}:refs/heads/lane/alpha`]);
    const create = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "create");
    expect(create?.argv).toContain("asdfqwerzxcc/dori-superagent");
    const merge = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "merge");
    expect(merge?.argv).toContain("asdfqwerzxcc/dori-superagent");
    const del = w.calls.find((call) => call.cmd === "git" && call.argv.includes("--delete"));
    expect(del?.argv).toEqual(["-C", repoPath, "push", "fork", "--delete", "lane/alpha"]);
    expect(w.calls.map((call) => call.argv.join(" ")).join("\n")).not.toContain("sisyphuslabs");
  });

  test("uses HEAD even when the recorded tipSha is older, and clips a long title", async () => {
    const { w, d, lane } = laneFixture();
    lane.tipSha = base;
    lane.final = { text: "long ".repeat(80), evidence: ["https://example.test/alpha"], at: 2 };
    d.store.saveLane(lane);
    receiptAt(d, tipA);
    laneGh(w);
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain(`head=${tipA.slice(0, 12)}`);

    const create = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "create");
    const argv = create?.argv ?? [];
    const title = argv[argv.indexOf("--title") + 1];
    expect(title?.length).toBe(256);
    expect(title).toEndWith("...");
  });

  test("a branch already gone counts as deleted", async () => {
    const { w, d, repo } = laneFixture();
    receiptAt(d, tipA);
    repo.deleteFails = "error: unable to delete 'lane/alpha': remote ref does not exist";
    laneGh(w);
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain("branch=deleted");
    expect(lines.some((line) => line.startsWith("WARN"))).toBe(false);
  });

  test("a real delete failure is a warning after a successful merge", async () => {
    const { w, d, repo } = laneFixture();
    receiptAt(d, tipA);
    repo.deleteFails = "remote: permission denied";
    laneGh(w);
    const lines = await mergeLane(d, "alpha");
    expect(lines.find((line) => line.startsWith("MERGED"))).toContain("branch=kept");
    expect(lines.some((line) => line.startsWith("WARN lane alpha"))).toBe(true);
  });
});
