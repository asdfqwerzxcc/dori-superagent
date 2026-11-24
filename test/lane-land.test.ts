import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeLane } from "../src/lane-land.ts";
import { laneFixture, laneGh, receiptAt, repoName, setFinal, tipA, tipB, url } from "./lane-land-setup.ts";

describe("lane landing", () => {
  test("a CLEAR receipt pushes, creates the PR, merges it as a merge commit and deletes the branch", async () => {
    const { w, d, repoPath } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w);
    setFinal(d, `READY alpha @ ${tipA}\n\nImplemented the lane gate.`);

    const dry = await mergeLane(d, "alpha", { dryRun: true });
    expect(dry.join("\n")).toContain(`repo=${repoName}`);
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);

    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toBe(
      `MERGED lane/alpha head=${tipA.slice(0, 12)} repo=${repoName} pr=#7 ${url} checks=green branch=deleted`,
    );

    const push = w.calls.find((call) => call.cmd === "git" && call.argv.includes(`${tipA}:refs/heads/lane/alpha`));
    expect(push?.argv).toEqual(["-C", repoPath, "push", "origin", `${tipA}:refs/heads/lane/alpha`]);

    const create = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "create");
    const argv = create?.argv ?? [];
    expect(argv[argv.indexOf("--title") + 1]).toBe("Implemented the lane gate.");
    const bodyPath = join(d.store.root, "state", "lane-prs", "alpha.md");
    expect(argv).toContain("--body-file");
    expect(argv).toContain(bodyPath);
    expect(readFileSync(bodyPath, "utf8")).toContain("https://example.test/alpha");

    const merge = w.calls.find((call) => call.cmd === "gh" && call.argv[1] === "merge");
    expect(merge?.argv).toContain("--merge");
    expect(merge?.argv).toContain("--match-head-commit");
    expect(merge?.argv).toContain(tipA);
    expect(merge?.argv).not.toContain("--squash");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "checks")).toBe(true);

    const pushAt = w.calls.findIndex(
      (call) => call.cmd === "git" && call.argv.includes(`${tipA}:refs/heads/lane/alpha`),
    );
    const createAt = w.calls.findIndex((call) => call.cmd === "gh" && call.argv[1] === "create");
    const mergeAt = w.calls.findIndex((call) => call.cmd === "gh" && call.argv[1] === "merge");
    const deleteAt = w.calls.findIndex((call) => call.cmd === "git" && call.argv.includes("--delete"));
    expect(pushAt).toBeGreaterThan(-1);
    expect(pushAt).toBeLessThan(createAt);
    expect(createAt).toBeLessThan(mergeAt);
    expect(mergeAt).toBeLessThan(deleteAt);

    const del = w.calls[deleteAt];
    expect(del?.argv).toEqual(["-C", repoPath, "push", "origin", "--delete", "lane/alpha"]);
  });

  test("merges a repo with no CI configured and records checks=none", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, {
      checks: { code: 1, stdout: "", stderr: "no checks reported on the 'main' branch" },
      workflows: 0,
    });
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain("checks=none");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(true);
  });

  test("refuses when the repo has workflows but no checks registered", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { checks: { code: 1, stdout: "", stderr: "no checks reported" }, workflows: 1 });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("1 workflow");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("refuses an unreadable workflow count without merging", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, {
      checks: { code: 1, stdout: "", stderr: "no checks reported" },
      workflows: { code: 0, stdout: "" },
    });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("(empty or whitespace)");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("refuses a gh pr checks failure with its message", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { checks: { code: 1, stdout: "", stderr: "HTTP 502: bad gateway" }, workflows: 1 });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("HTTP 502");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("refuses all-skipped checks when the repo has workflows", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { checks: [{ name: "test", bucket: "skipping" }], workflows: 1 });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("skipped");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("updates an existing open PR before merging it", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { existing: true });
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain("pr=#7");
    const editAt = w.calls.findIndex((call) => call.cmd === "gh" && call.argv[1] === "edit");
    const mergeAt = w.calls.findIndex((call) => call.cmd === "gh" && call.argv[1] === "merge");
    expect(editAt).toBeGreaterThan(-1);
    expect(editAt).toBeLessThan(mergeAt);
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "create")).toBe(false);
  });

  test("refuses an open PR based on develop", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { existing: true, base: "develop" });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("base is develop, not main");
    expect(w.calls.some((call) => call.cmd === "gh" && (call.argv[1] === "edit" || call.argv[1] === "merge"))).toBe(
      false,
    );
  });

  test("refuses an open PR whose head sha is not the lane head", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { existing: true, prHead: tipB });
    await expect(mergeLane(d, "alpha")).rejects.toThrow(`not ${tipA.slice(0, 12)}`);
    expect(w.calls.some((call) => call.cmd === "gh" && (call.argv[1] === "edit" || call.argv[1] === "merge"))).toBe(
      false,
    );
  });

  test("refuses an open PR whose head is another fork", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { existing: true, cross: true, headRepo: "someone/else" });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("cross-repository");
    expect(w.calls.some((call) => call.cmd === "gh" && (call.argv[1] === "edit" || call.argv[1] === "merge"))).toBe(
      false,
    );
  });

  test("a reused lane key creates a new PR when the old PR merged another head (done -> start -> merge)", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { stale: "older" });
    const lines = await mergeLane(d, "alpha");
    expect(lines.at(-1)).toContain("pr=#7");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "create")).toBe(true);
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(true);
  });

  test("a retry after a successful merge refuses before any push", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { stale: "at-head" });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("at this exact head");
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "create")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("refuses to merge when PR checks are not green", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA);
    laneGh(w, { checks: [{ name: "test", bucket: "pending" }] });
    await expect(mergeLane(d, "alpha")).rejects.toThrow("test=pending");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "checks")).toBe(true);
  });

  test("refuses a BLOCK receipt at the tip before any push or PR", async () => {
    const { w, d } = laneFixture();
    receiptAt(d, tipA, "BLOCK");
    await expect(mergeLane(d, "alpha")).rejects.toThrow("is BLOCK");
    expect(w.calls.some((call) => call.cmd === "gh")).toBe(false);
    expect(w.calls.some((call) => call.cmd === "git" && call.argv.includes("push"))).toBe(false);
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
