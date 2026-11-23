import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLane } from "../src/lane-review.ts";
import { startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const AUTH = "No API key found for opencode.\n";

const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;

const threeFiles = (): string =>
  section("src/a.ts", "a".repeat(6_000)) +
  section("src/b.ts", "b".repeat(6_000)) +
  section("src/c.ts", "c".repeat(6_000));

async function lane(key: string) {
  const { w, d, brief } = setup();
  const repo: Repo = { head: base, mergeBase: base, diff: threeFiles() };
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

const reviewerCalls = (w: ReturnType<typeof setup>["w"]) => w.calls.filter((c) => c.cmd === "omo");

type Diagnostic = {
  exitCode: number | null;
  model: string | null;
  cause?: string;
  retried?: true;
  retryModel?: string;
};

const diagnostics = (d: ReturnType<typeof setup>["d"]): Diagnostic[] =>
  readdirSync(join(d.store.root, "receipts"))
    .filter((n) => n.endsWith(".diagnostic.json"))
    .map((n) => JSON.parse(readFileSync(join(d.store.root, "receipts", n), "utf8")) as Diagnostic);

describe("lane review fallback: primary-down edge cases", () => {
  test("a thrown primary is retried on the fallback and marks the primary down", async () => {
    const { w, d } = await lane("spawn");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) => {
      if (argv.includes("fallback/m")) return { code: 0, stdout: "VERDICT: CLEAR" };
      throw new Error("spawn ENOENT");
    };

    expect(await reviewLane(d, "spawn", "primary/m", { timeoutMs: 5_000, budgetMs: 20_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    const calls = reviewerCalls(w);
    expect(calls.filter((c) => c.argv.includes("primary/m"))).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const receipt = d.store.laneReceipt("spawn", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.reviewer).toContain("fallback/m");
    expect(receipt.chunks?.map((c) => c.primaryDown)).toEqual([true, true]);
    expect(diagnostics(d)).toMatchObject([
      {
        exitCode: null,
        model: "primary/m",
        cause: "threw: spawn ENOENT",
        retried: true,
        retryModel: "fallback/m",
      },
    ]);
  });

  test("a skipped chunk with a failed fallback does not borrow the first chunk's diagnostic", async () => {
    const { w, d } = await lane("skip-note");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) => {
      if (!argv.includes("fallback/m")) return { code: 1, stdout: "", stderr: AUTH };
      return (argv.at(-1) ?? "").includes("src/c.ts")
        ? { code: 0, stdout: "no verdict here" }
        : { code: 0, stdout: "VERDICT: CLEAR" };
    };

    const error = await failed(() => reviewLane(d, "skip-note", "primary/m", { timeoutMs: 5_000 }));
    expect(error.message).toContain("review_partial");
    const receipt = d.store.laneReceipt("skip-note", tip)!;
    expect(receipt.verdict).toBe("review_partial");
    const skippedNote = receipt.summary.split("\n").find((l) => l.includes("chunk 2/2: primary skipped"));
    expect(skippedNote).toBeDefined();
    expect(skippedNote).not.toContain("primary diagnostic");
    const found = diagnostics(d);
    expect(found).toHaveLength(2);
    expect(found.find((x) => x.model === "primary/m")?.cause).toContain("No API key found");
    expect(found.find((x) => x.model === "fallback/m")?.cause).toBe("no verdict");
  });

  test("an auth-looking stack line with an empty stdout does not mark the primary down", async () => {
    const { w, d } = await lane("stack-auth");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) =>
      argv.includes("fallback/m")
        ? { code: 0, stdout: "VERDICT: CLEAR" }
        : { code: 1, stdout: "", stderr: "    at authenticate (src/auth.ts:1:1)\nstream reset" };

    expect(await reviewLane(d, "stack-auth", "primary/m", { timeoutMs: 5_000, budgetMs: 20_000 })).toEqual({
      verdict: "CLEAR",
      base,
      tip,
    });
    expect(reviewerCalls(w).filter((c) => c.argv.includes("primary/m"))).toHaveLength(2);
    const receipt = d.store.laneReceipt("stack-auth", tip)!;
    expect(receipt.chunks?.some((c) => c.primaryDown === true)).toBe(false);
  });
});
