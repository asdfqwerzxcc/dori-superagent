import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLane } from "../src/lane-review.ts";
import { startLane } from "../src/lanes.ts";
import { progressPath } from "../src/review-progress.ts";
import { REVIEW_ATTEMPT_MS, REVIEW_TIMEOUT_MS } from "../src/review-run.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const single = "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n+export const x = 1;\n";

const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;

const threeChunks = (): string =>
  ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => section(path, path[0]!.repeat(9_000))).join("");

async function lane(key: string, repoDiff: string = single) {
  const { w, d, brief } = setup();
  const repo: Repo = { head: base, mergeBase: base, diff: repoDiff };
  fakeGit(w, repo);
  await startLane(d, key, brief, { group: "w1" });
  repo.head = tip;
  return { w, d };
}

const failed = async (run: () => Promise<unknown>): Promise<Error> => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

const canonical = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt => {
  const receipt = d.store.laneReceipt(key, tip);
  expect(receipt).toBeDefined();
  return receipt!;
};

describe("lane review policy", () => {
  test("a single-diff reviewer that throws writes a failure receipt and diagnostic", async () => {
    const { w, d } = await lane("single-throw");
    w.reviewer = () => {
      throw new Error("spawn ENOENT");
    };

    const error = await failed(() => reviewLane(d, "single-throw"));
    expect(error.message).toContain("review_partial");
    expect(error.message).toContain("spawn ENOENT");
    const receipt = canonical(d, "single-throw");
    expect(receipt.verdict).toBe("review_partial");
    expect(receipt.summary).toContain("spawn ENOENT");

    const files = readdirSync(join(d.store.root, "receipts")).filter((f) => f.endsWith(".diagnostic.json"));
    expect(files).toHaveLength(1);
    const diagnostic = JSON.parse(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8"));
    expect(diagnostic.exitCode).toBeNull();
    expect(diagnostic.stderrTail).toContain("spawn ENOENT");
    expect(diagnostic.argv?.[0]).toBe("omo");
  });

  test("a later CLEAR at the same tip does not replace a BLOCK", async () => {
    const { w, d } = await lane("block-wins", threeChunks());
    w.reviewer = () => ({ code: 0, stdout: "HIGH\nVERDICT: BLOCK" });
    expect(await reviewLane(d, "block-wins")).toEqual({ verdict: "BLOCK", base, tip });
    expect(canonical(d, "block-wins").verdict).toBe("BLOCK");

    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect(await reviewLane(d, "block-wins")).toEqual({ verdict: "BLOCK", base, tip });
    const receipt = canonical(d, "block-wins");
    expect(receipt.verdict).toBe("BLOCK");
    const progress = JSON.parse(readFileSync(progressPath(d.store.root, "block-wins", tip), "utf8")) as LaneReceipt;
    expect(progress.verdict).toBe("CLEAR");
  });

  test("any chunk BLOCK wins over a timeout and replaces an older CLEAR", async () => {
    const { w, d } = await lane("block-timeout", threeChunks());
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect(await reviewLane(d, "block-timeout")).toEqual({ verdict: "CLEAR", base, tip });
    expect(canonical(d, "block-timeout").verdict).toBe("CLEAR");

    w.reviewer = (argv, options) => {
      const text = argv.at(-1) ?? "";
      if (text.includes("src/a.ts")) return { code: 0, stdout: "HIGH\nVERDICT: BLOCK" };
      if (text.includes("src/b.ts")) {
        options?.onSpawn?.({ kill: () => {} });
        return new Promise(() => {});
      }
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };
    expect(await reviewLane(d, "block-timeout", undefined, { timeoutMs: 80, budgetMs: 10_000 })).toEqual({
      verdict: "BLOCK",
      base,
      tip,
    });
    const receipt = canonical(d, "block-timeout");
    expect(receipt.verdict).toBe("BLOCK");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["BLOCK", "timed out", "CLEAR"]);
  });

  test("the default chunk window is 30 minutes and each attempt gets 15", () => {
    expect(REVIEW_TIMEOUT_MS).toBe(30 * 60_000);
    expect(REVIEW_ATTEMPT_MS).toBe(15 * 60_000);
    expect(REVIEW_ATTEMPT_MS * 2).toBe(REVIEW_TIMEOUT_MS);
  });
});
