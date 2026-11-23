import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { reviewLane } from "../src/lane-review.ts";
import { checkpointPath } from "../src/review-checkpoint.ts";
import { startLane } from "../src/lanes.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

/** A diff big enough for one chunk per file: 9 KB each is over half the 16 KB cap, so packing cannot pair them. */
const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;

const large = (paths: readonly string[]) => paths.map((path) => section(path, path[0]!.repeat(9_000))).join("");

async function lane(key: string, repoDiff: string) {
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

const receiptOf = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt => {
  const receipt = d.store.laneReceipt(key, tip);
  expect(receipt).toBeDefined();
  return receipt!;
};

describe("lane review resume", () => {
  test("a large diff completes every chunk and the receipt names each chunk's state", async () => {
    const { w, d } = await lane("all-chunks", large(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]));
    w.reviewer = (argv) =>
      (argv.at(-1) ?? "").includes("src/d.ts")
        ? { code: 0, stdout: "HIGH src/d.ts:1 breaks the page\nVERDICT: BLOCK" }
        : { code: 0, stdout: "VERDICT: CLEAR" };

    expect(await reviewLane(d, "all-chunks")).toEqual({ verdict: "BLOCK", base, tip });
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(4);

    const receipt = receiptOf(d, "all-chunks");
    expect(receipt.verdict).toBe("BLOCK");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "CLEAR", "CLEAR", "BLOCK"]);
    expect(receipt.chunks?.map((c) => c.paths[0])).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    for (const chunk of receipt.chunks ?? []) {
      expect(chunk.bytes).toBeGreaterThan(8_000);
      expect(chunk.lines).toBe(1);
    }
    expect(receipt.summary).toContain("chunks:");
    expect(receipt.summary).toContain("-> CLEAR");
    expect(receipt.summary).toContain("-> BLOCK");
    expect(existsSync(checkpointPath(d.store.root, "all-chunks", tip))).toBe(false);
  });

  test("a chunk timeout leaves a partial receipt while it runs and every chunk's state after it", async () => {
    const { w, d } = await lane("partial", large(["src/a.ts", "src/b.ts", "src/c.ts"]));
    const during: LaneReceipt[] = [];
    w.reviewer = (argv, options) => {
      const text = argv.at(-1) ?? "";
      if (text.includes("src/b.ts")) {
        during.push(receiptOf(d, "partial"));
        options?.onSpawn?.({
          kill: () => {},
        });
        return new Promise(() => {});
      }
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const error = await failed(() => reviewLane(d, "partial", undefined, { timeoutMs: 80, budgetMs: 10_000 }));
    expect(error.message).toContain("reviewer_timeout");
    expect(error.message).toContain("incomplete");

    expect(during).toHaveLength(1);
    expect(during[0]!.verdict).toBe("review_partial");
    expect(during[0]!.chunks?.map((c) => c.state)).toEqual(["CLEAR", "running", "pending"]);

    const receipt = receiptOf(d, "partial");
    expect(receipt.verdict).toBe("reviewer_timeout");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "timed out", "CLEAR"]);
    expect(receipt.summary).toContain("timed out");
    expect(receipt.summary).toContain("src/a.ts");
    expect(receipt.summary).toContain("src/c.ts");
    expect(existsSync(checkpointPath(d.store.root, "partial", tip))).toBe(true);
    expect(d.store.lane("partial")!.tipSha).toBe(base);
  });

  test("a retry reuses every chunk that already answered", async () => {
    const { w, d } = await lane("retry", large(["src/a.ts", "src/b.ts", "src/c.ts"]));
    let hang = true;
    w.reviewer = (argv, options) => {
      const text = argv.at(-1) ?? "";
      if (hang && text.includes("src/b.ts")) {
        options?.onSpawn?.({
          kill: () => {},
        });
        return new Promise(() => {});
      }
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const first = await failed(() => reviewLane(d, "retry", "some/model", { timeoutMs: 80, budgetMs: 10_000 }));
    expect(first.message).toContain("reviewer_timeout");
    expect(receiptOf(d, "retry").chunks?.map((c) => c.state)).toEqual(["CLEAR", "timed out", "CLEAR"]);
    const callsAfterFirst = w.calls.filter((c) => c.cmd === "omo").length;
    expect(callsAfterFirst).toBe(3);

    hang = false;
    const second = await reviewLane(d, "retry", "some/model", { timeoutMs: 80, budgetMs: 10_000 });
    expect(second).toEqual({ verdict: "CLEAR", base, tip });
    const secondCalls = w.calls.filter((c) => c.cmd === "omo").slice(callsAfterFirst);
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]!.argv.at(-1)).toContain("src/b.ts");

    const receipt = receiptOf(d, "retry");
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "CLEAR", "CLEAR"]);
    expect(receipt.chunks?.map((c) => c.reused === true)).toEqual([true, false, true]);
    expect(receipt.summary).toContain("(reused)");
    expect(existsSync(checkpointPath(d.store.root, "retry", tip))).toBe(false);
  });

  test("the job budget stops the run and marks the chunks it cannot afford as not run", async () => {
    const { w, d } = await lane("budget", large(["src/a.ts", "src/b.ts", "src/c.ts"]));
    w.reviewer = (argv, options) => {
      const text = argv.at(-1) ?? "";
      if (text.includes("src/b.ts")) {
        options?.onSpawn?.({
          kill: () => {},
        });
        return new Promise(() => {});
      }
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const error = await failed(() => reviewLane(d, "budget", undefined, { timeoutMs: 30_000, budgetMs: 1_500 }));
    expect(error.message).toContain("reviewer_timeout");
    expect(error.message).toContain("budget");
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(2);

    const receipt = receiptOf(d, "budget");
    expect(receipt.verdict).toBe("reviewer_timeout");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "timed out", "not run"]);
    expect(receipt.chunks?.[2]?.note ?? "").toContain("budget");
  });

  test("a checkpoint from another reviewer is not reused", async () => {
    const { w, d } = await lane("other-model", large(["src/a.ts", "src/b.ts", "src/c.ts"]));
    let hang = true;
    w.reviewer = (argv, options) => {
      const text = argv.at(-1) ?? "";
      if (hang && text.includes("src/b.ts")) {
        options?.onSpawn?.({
          kill: () => {},
        });
        return new Promise(() => {});
      }
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };
    expect(
      await failed(() => reviewLane(d, "other-model", "model/one", { timeoutMs: 80, budgetMs: 10_000 })),
    ).toBeInstanceOf(Error);
    expect(existsSync(checkpointPath(d.store.root, "other-model", tip))).toBe(true);

    hang = false;
    expect(await reviewLane(d, "other-model", "model/two", { timeoutMs: 80, budgetMs: 10_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(6);
    const receipt = receiptOf(d, "other-model");
    expect(receipt.reviewer).toContain("model/two");
    expect(receipt.chunks?.some((c) => c.reused === true)).toBe(false);
  });

  test("a re-split parent is re-attempted while its answered sub-chunks are reused", async () => {
    const packed = ["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => section(path, path[0]!.repeat(6_000))).join("");
    const { w, d } = await lane("resplit-reuse", packed);
    let bAnswers = false;
    w.reviewer = (argv) => {
      const text = argv.at(-1) ?? "";
      const a = text.includes("src/a.ts");
      const b = text.includes("src/b.ts");
      if (a && b) return { code: 0, stdout: "" };
      if (a) return { code: 0, stdout: "VERDICT: CLEAR" };
      if (b) return { code: 0, stdout: bAnswers ? "VERDICT: CLEAR" : "" };
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const first = await failed(() => reviewLane(d, "resplit-reuse"));
    expect(first.message).toContain("reviewer_empty");
    const callsAfterFirst = w.calls.filter((c) => c.cmd === "omo").length;
    expect(callsAfterFirst).toBe(4);

    bAnswers = true;
    expect(await reviewLane(d, "resplit-reuse")).toEqual({ verdict: "CLEAR", base, tip });
    const secondCalls = w.calls.filter((c) => c.cmd === "omo").slice(callsAfterFirst);
    expect(secondCalls).toHaveLength(2);
    const prompts = secondCalls.map((c) => c.argv.at(-1) ?? "");
    expect(prompts.some((text) => text.includes("src/a.ts") && text.includes("src/b.ts"))).toBe(true);
    expect(prompts.some((text) => text.includes("src/a.ts") && !text.includes("src/b.ts"))).toBe(false);

    const receipt = receiptOf(d, "resplit-reuse");
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["empty", "CLEAR", "CLEAR", "CLEAR"]);
    expect(receipt.chunks?.map((c) => c.reused === true)).toEqual([false, true, false, true]);
    expect(receipt.summary).toContain("re-split");
    expect(receipt.summary).toContain("(reused)");
    expect(existsSync(checkpointPath(d.store.root, "resplit-reuse", tip))).toBe(false);
  });
});
