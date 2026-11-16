import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewLane } from "../src/lane-review.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { reviewLogPath, runReviewer } from "../src/review-run.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

async function lane(key: string, repoDiff: string = diff) {
  const { w, d, brief } = setup();
  const repo: Repo = { head: base, mergeBase: base, diff: repoDiff };
  fakeGit(w, repo);
  await startLane(d, key, brief, { group: "w1" });
  repo.head = tip;
  return { w, d, repo };
}

const failed = async (run: () => Promise<unknown>): Promise<Error> => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

describe("lane review deadline", () => {
  test("a hung reviewer is killed at the deadline and leaves a reviewer_timeout receipt", async () => {
    const { w, d } = await lane("hung");
    let killed = false;
    w.reviewer = (_argv, options) => {
      options?.onStdout?.("partial finding\n");
      options?.onSpawn?.({
        kill: () => {
          killed = true;
        },
      });
      return new Promise(() => {});
    };
    await ready(d, "hung", "done", ["file:///x"]);

    const started = Date.now();
    const error = await failed(() => reviewLane(d, "hung", undefined, { timeoutMs: 60, progressMs: 10 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(killed).toBe(true);
    expect(error.message).toContain("reviewer_timeout");

    const receipt = d.store.laneReceipt("hung", tip)!;
    expect(receipt.verdict).toBe("reviewer_timeout");
    expect(receipt.summary).toContain("timed out");
    expect(readFileSync(reviewLogPath(d.store.root, "hung"), "utf8")).toContain("partial finding");
    expect(d.store.lane("hung")!.tipSha).toBe(base);
    await expect(done(d, "hung")).rejects.toThrow("reviewer_timeout");
  });

  test("an empty reviewer answer is a reviewer_empty receipt, never a pending review", async () => {
    const { w, d } = await lane("silent");
    w.reviewer = () => ({ code: 0, stdout: "", stderr: "child reaper warning" });
    await ready(d, "silent", "done", ["file:///x"]);

    const error = await failed(() => reviewLane(d, "silent"));
    expect(error.message).toContain("reviewer_empty");
    const receipt = d.store.laneReceipt("silent", tip)!;
    expect(receipt.verdict).toBe("reviewer_empty");
    expect(receipt.summary).toContain("exit 0");
    expect(receipt.summary).toContain("child reaper warning");
    expect(readFileSync(reviewLogPath(d.store.root, "silent"), "utf8")).toContain("review lane silent");
    expect(d.store.lane("silent")!.tipSha).toBe(base);
    await expect(done(d, "silent")).rejects.toThrow("reviewer_empty");
  });

  test("a reviewer that prints a verdict and then exits non-zero writes no receipt", async () => {
    const { w, d } = await lane("crash");
    w.reviewer = () => ({ code: 3, stdout: "VERDICT: CLEAR", stderr: "provider died" });

    const error = await failed(() => reviewLane(d, "crash"));
    expect(error.message).toContain("exited 3");
    expect(error.message).toContain("provider died");
    expect(d.store.laneReceipt("crash", tip)).toBeUndefined();
    expect(d.store.lane("crash")!.tipSha).toBe(base);
  });

  test("a diff over the size cap is split by path and the receipt names every chunk", async () => {
    const section = (path: string, fill: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;
    const big = section("src/a.ts", "a".repeat(30_000)) + section("src/b.ts", "b".repeat(30_000));
    const { w, d } = await lane("big", big);
    w.reviewer = (argv) =>
      (argv.at(-1) ?? "").includes("src/b.ts")
        ? { code: 0, stdout: "HIGH src/b.ts:1 bug\nVERDICT: BLOCK" }
        : { code: 0, stdout: "VERDICT: CLEAR" };

    expect(await reviewLane(d, "big")).toEqual({ verdict: "BLOCK", base, tip });
    const reviewers = w.calls.filter((c) => c.cmd === "omo");
    expect(reviewers).toHaveLength(2);
    expect(reviewers[0]!.argv.at(-1)).toContain("This is chunk 1 of 2");
    expect(reviewers[1]!.argv.at(-1)).toContain("This is chunk 2 of 2");
    expect(readFileSync(d.store.receipts.laneChunkDiffPath("big", tip, 1), "utf8")).toContain("src/a.ts");
    expect(readFileSync(d.store.receipts.laneChunkDiffPath("big", tip, 2), "utf8")).toContain("src/b.ts");

    const receipt = d.store.laneReceipt("big", tip)!;
    expect(receipt.verdict).toBe("BLOCK");
    expect(receipt.summary).toContain("chunks:");
    expect(receipt.summary).toContain("src/a.ts");
    expect(receipt.summary).toContain("src/b.ts");
    expect(receipt.summary).toContain("-> CLEAR");
    expect(receipt.summary).toContain("-> BLOCK");
    expect(readFileSync(d.store.laneDiffPath("big", tip), "utf8")).toBe(big);
  });
});

describe("reviewer progress", () => {
  test("runReviewer streams output to the log and reports progress while the reviewer runs", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "dori-review-log-")), "lane.log");
    const lines: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enough: () => void = () => {};
    const progressed = new Promise<void>((resolve) => {
      enough = resolve;
    });
    const run = runReviewer({
      exec: async (_cmd, _argv, options) => {
        options?.onStdout?.("partial output\n");
        await gate;
        return { code: 0, stdout: "partial output\nVERDICT: CLEAR", stderr: "" };
      },
      cmd: "omo",
      argv: [],
      log,
      label: "review lane probe",
      timeoutMs: 2_000,
      progressMs: 5,
      onProgress: (line) => {
        lines.push(line);
        if (lines.length >= 2) enough();
      },
    });
    await Promise.race([
      progressed,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("no progress line")), 1_000);
      }),
    ]);
    release();
    expect((await run).kind).toBe("exit");
    expect(lines[0]).toContain("still running");
    expect(readFileSync(log, "utf8")).toBe("partial output\n");
  });
});
