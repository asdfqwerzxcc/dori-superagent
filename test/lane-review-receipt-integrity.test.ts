import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { laneGate } from "../src/lane-gate.ts";
import { writeJson } from "../src/json-file.ts";
import { reviewLane } from "../src/lane-review.ts";
import { startLane } from "../src/lanes.ts";
import { progressPath } from "../src/review-progress.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;

/** Two 9 KB files: over half the 16 KB cap each, so they become two top-level chunks. */
const twoChunks = (): string => section("src/a.ts", "a".repeat(9_000)) + section("src/b.ts", "b".repeat(9_000));
const threeChunks = (): string => `${twoChunks()}${section("src/c.ts", "c".repeat(9_000))}`;

async function lane(key: string, repoDiff: string = twoChunks()) {
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

const sidecar = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt | undefined => {
  const path = progressPath(d.store.root, key, tip);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LaneReceipt;
};

/** Resolves only when the test says so; no sleeps, so the two-job order is exact. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("lane review receipt integrity", () => {
  test("a job that fails after another job wrote CLEAR keeps the CLEAR and records its failure in the sidecar", async () => {
    const { w, d } = await lane("race");
    const gateA = deferred();
    const gateB = deferred();
    const aStarted = deferred();
    const bStarted = deferred();
    w.reviewer = async (argv) => {
      if (argv.includes("model/a")) {
        aStarted.resolve();
        await gateA.promise;
        return { code: 0, stdout: "VERDICT: CLEAR" };
      }
      bStarted.resolve();
      await gateB.promise;
      return { code: 2, stdout: "", stderr: "provider down" };
    };

    const aRun = reviewLane(d, "race", "model/a", { timeoutMs: 5_000, budgetMs: 10_000 });
    await aStarted.promise;
    const bRun = reviewLane(d, "race", "model/b", { timeoutMs: 5_000, budgetMs: 10_000 });
    await bStarted.promise;
    // A has written its plan-time partial; B has too. Now A finishes CLEAR while B is still on its first chunk.
    gateA.resolve();
    expect(await aRun).toEqual({ verdict: "CLEAR", base, tip });
    expect(canonical(d, "race").verdict).toBe("CLEAR");
    gateB.resolve();

    const bError = await failed(() => bRun);
    expect(bError.message).toContain("reviewer_empty");
    expect(bError.message).toContain("canonical receipt stays CLEAR");
    const receipt = canonical(d, "race");
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "CLEAR"]);
    const progress = sidecar(d, "race");
    expect(progress?.verdict).toBe("reviewer_empty");
    expect(progress?.reviewer).toContain("model/b");
  });

  test("a failed sequential re-review of a CLEAR tip keeps the CLEAR", async () => {
    const { w, d } = await lane("re-review");
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect(await reviewLane(d, "re-review")).toEqual({ verdict: "CLEAR", base, tip });

    w.reviewer = () => ({ code: 2, stdout: "", stderr: "provider down" });
    const error = await failed(() => reviewLane(d, "re-review", undefined, { timeoutMs: 1_000, budgetMs: 5_000 }));
    expect(error.message).toContain("canonical receipt stays CLEAR");
    expect(canonical(d, "re-review").verdict).toBe("CLEAR");
    expect(canonical(d, "re-review").chunks?.map((c) => c.state)).toEqual(["CLEAR", "CLEAR"]);
    const progress = sidecar(d, "re-review");
    expect(progress?.verdict).toBe("reviewer_empty");
    expect(progress?.chunks?.map((c) => c.state)).toEqual(["empty", "empty"]);
  });

  test("a reviewer that throws is that chunk's failure and later chunks still run", async () => {
    const { w, d } = await lane("throwing", threeChunks());
    w.reviewer = (argv) => {
      const text = argv.at(-1) ?? "";
      if (text.includes("src/b.ts")) throw new Error("spawn ENOENT");
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const error = await failed(() => reviewLane(d, "throwing"));
    expect(error.message).toContain("review_partial");
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(3);
    const receipt = canonical(d, "throwing");
    expect(receipt.verdict).toBe("review_partial");
    expect(receipt.chunks?.map((c) => c.state)).toEqual(["CLEAR", "failed", "CLEAR"]);
    expect(receipt.chunks?.[1]?.note ?? "").toContain("spawn ENOENT");
    expect(receipt.summary).toContain("spawn ENOENT");

    const files = readdirSync(join(d.store.root, "receipts")).filter((f) => f.endsWith(".diagnostic.json"));
    expect(files).toHaveLength(1);
    const diagnostic = JSON.parse(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8"));
    expect(diagnostic.exitCode).toBeNull();
    expect(diagnostic.stderrTail).toContain("spawn ENOENT");
  });

  test("a reused fallback answer is named in the top-level reviewer field", async () => {
    const { w, d } = await lane("reused-fallback");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    let chunk2PrimaryClears = false;
    w.reviewer = (argv) => {
      const text = argv.at(-1) ?? "";
      const fallback = argv.includes("fallback/m");
      if (text.includes("src/b.ts")) {
        if (fallback) return { code: 2, stdout: "", stderr: "down" };
        return { code: 0, stdout: chunk2PrimaryClears ? "VERDICT: CLEAR" : "no verdict" };
      }
      return { code: 0, stdout: fallback ? "VERDICT: CLEAR" : "no verdict" };
    };

    const first = await failed(() =>
      reviewLane(d, "reused-fallback", "primary/m", { timeoutMs: 1_000, budgetMs: 5_000 }),
    );
    expect(first.message).toContain("reviewer_empty");
    expect(canonical(d, "reused-fallback").chunks?.map((c) => c.state)).toEqual(["CLEAR", "empty"]);
    const callsAfterFirst = w.calls.filter((c) => c.cmd === "omo").length;
    expect(callsAfterFirst).toBe(4);

    chunk2PrimaryClears = true;
    expect(await reviewLane(d, "reused-fallback", "primary/m", { timeoutMs: 1_000, budgetMs: 5_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    const secondCalls = w.calls.filter((c) => c.cmd === "omo").slice(callsAfterFirst);
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]!.argv.at(-1)).toContain("src/b.ts");
    const receipt = canonical(d, "reused-fallback");
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.reviewer).toContain("fallback/m");
    expect(receipt.chunks?.[0]?.reused).toBe(true);
    expect(receipt.chunks?.[0]?.model).toBe("fallback/m");
    expect(receipt.summary).toContain("reused fallback/m");
  });

  test("review_partial never passes the gate, and a live job still reports in flight", async () => {
    const { d } = await lane("gate");
    d.store.saveLaneReceipt({
      lane: "gate",
      verdict: "review_partial",
      base,
      tip,
      brief: d.store.briefPath("gate"),
      reviewer: "test",
      at: d.now(),
      summary: "review in progress",
      chunks: [],
    });
    const record = d.store.lane("gate")!;
    const partial = await laneGate(d, record);
    expect(partial.ok).toBe(false);
    expect(partial.ok ? "" : partial.reason).toContain("review_partial");

    const queue = join(d.store.root, "state", "review-queue");
    mkdirSync(queue, { recursive: true });
    writeJson(join(queue, `gate@${tip}.json`), {
      lane: "gate",
      tip,
      base,
      requestedAt: d.now(),
      state: "queued",
    });
    const inFlight = await laneGate(d, record);
    expect(inFlight.ok).toBe(false);
    expect(inFlight.ok ? "" : inFlight.reason).toContain("a review is in flight");
  });
});
