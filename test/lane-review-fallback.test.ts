import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLane } from "../src/lane-review.ts";
import { startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;

/** Three 6 KB files: two top-level chunks, and chunk 1 could still be re-split into two sub-chunks. */
const threeFiles = (): string =>
  section("src/a.ts", "a".repeat(6_000)) +
  section("src/b.ts", "b".repeat(6_000)) +
  section("src/c.ts", "c".repeat(6_000));

const smallDiff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

const AUTH = "No API key found for opencode.\n";

async function lane(key: string, repoDiff: string = threeFiles()) {
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

type Diagnostic = {
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  model: string | null;
  chunk?: string;
  cause?: string;
  retried?: true;
  retryModel?: string;
};

const diagnostics = (d: ReturnType<typeof setup>["d"]): Diagnostic[] =>
  readdirSync(join(d.store.root, "receipts"))
    .filter((n) => n.endsWith(".diagnostic.json"))
    .map((n) => JSON.parse(readFileSync(join(d.store.root, "receipts", n), "utf8")) as Diagnostic);

const reviewerCalls = (w: ReturnType<typeof setup>["w"]) => w.calls.filter((c) => c.cmd === "omo");

describe("lane review fallback on immediate failure", () => {
  test("a primary auth failure falls back in the same window instead of re-splitting the chunk", async () => {
    const { w, d } = await lane("auth");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) =>
      argv.includes("fallback/m") ? { code: 0, stdout: "VERDICT: CLEAR" } : { code: 1, stdout: "", stderr: AUTH };

    expect(await reviewLane(d, "auth", "primary/m", { timeoutMs: 5_000, budgetMs: 20_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    const receipt = d.store.laneReceipt("auth", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.reviewer).toContain("fallback/m");
    expect(receipt.summary).not.toContain("re-split");
    expect(receipt.chunks).toHaveLength(2);
    expect(receipt.chunks?.every((c) => c.state === "CLEAR")).toBe(true);
    expect(receipt.chunks?.every((c) => c.model === "fallback/m")).toBe(true);

    // The primary failed immediately on chunk 1; the next call for that chunk is the fallback, not a sub-chunk.
    const calls = reviewerCalls(w);
    expect(calls[0]!.argv).toContain("primary/m");
    expect(calls[1]!.argv).toContain("fallback/m");
    expect(calls[1]!.argv.at(-1)).toContain("This is chunk 1 of 2");
    expect(calls[1]!.argv.at(-1)).not.toContain("This is chunk 1 of 1");
  });

  test("a primary timeout still falls back inside the chunk window", async () => {
    const { w, d } = await lane("timeout");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    let primaryKilled = false;
    w.reviewer = (argv, options) => {
      if (argv.includes("fallback/m")) return { code: 0, stdout: "VERDICT: CLEAR" };
      options?.onSpawn?.({
        kill: () => {
          primaryKilled = true;
        },
      });
      return new Promise(() => {});
    };

    expect(await reviewLane(d, "timeout", "primary/m", { timeoutMs: 2_000, budgetMs: 20_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    expect(primaryKilled).toBe(true);
    const receipt = d.store.laneReceipt("timeout", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.chunks?.[0]?.model).toBe("fallback/m");
    expect(receipt.reviewer).toContain("fallback/m");
    const match = /timed out after (\d+) ms/.exec(receipt.summary);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(2_000);
  });

  test("after an auth failure the primary is skipped for the remaining chunks", async () => {
    const { w, d } = await lane("primary-down");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) =>
      argv.includes("fallback/m") ? { code: 0, stdout: "VERDICT: CLEAR" } : { code: 1, stdout: "", stderr: AUTH };

    expect(await reviewLane(d, "primary-down", "primary/m", { timeoutMs: 5_000, budgetMs: 20_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    const calls = reviewerCalls(w);
    // primary chunk 1, fallback chunk 1, fallback chunk 2 - the dead primary is not tried again.
    expect(calls).toHaveLength(3);
    expect(calls.filter((c) => c.argv.includes("primary/m"))).toHaveLength(1);
    expect(calls[2]!.argv).toContain("fallback/m");
    expect(calls[2]!.argv.at(-1)).toContain("This is chunk 2 of 2");

    const receipt = d.store.laneReceipt("primary-down", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.chunks?.[1]?.primaryDown).toBe(true);
    expect(receipt.chunks?.[1]?.model).toBe("fallback/m");
    expect(receipt.summary).toContain("skipped");
  });

  test("when the primary and the fallback both fail the receipt fails and both diagnostics are kept", async () => {
    const { w, d } = await lane("both-fail", smallDiff);
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) => ({
      code: 1,
      stdout: "",
      stderr: argv.includes("fallback/m") ? "fallback key rejected\n" : `child reaper unavailable under Bun\n${AUTH}`,
    });

    const error = await failed(() => reviewLane(d, "both-fail", "primary/m", { timeoutMs: 5_000 }));
    expect(error.message).toContain("reviewer_empty");
    const receipt = d.store.laneReceipt("both-fail", tip)!;
    expect(receipt.verdict).toBe("reviewer_empty");
    expect(receipt.reviewer).toContain("primary/m");
    expect(receipt.reviewer).toContain("fallback/m");

    const found = diagnostics(d);
    expect(found).toHaveLength(2);
    const primary = found.find((x) => x.model === "primary/m")!;
    const fallback = found.find((x) => x.model === "fallback/m")!;
    expect(primary.retried).toBe(true);
    expect(primary.retryModel).toBe("fallback/m");
    expect(primary.cause).toContain("exit 1");
    expect(primary.cause).toContain("No API key found for opencode.");
    expect(primary.cause).not.toContain("child reaper");
    expect(primary.stderrTail).toContain("No API key found");
    expect(fallback.retried).toBe(true);
    expect(fallback.cause).toContain("exit 1");
    expect(fallback.stderrTail).toContain("fallback key rejected");
  });
});
