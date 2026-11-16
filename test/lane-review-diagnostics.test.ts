import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewLane } from "../src/lane-review.ts";
import { resplitChunk } from "../src/review-chunks.ts";
import { startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

type Diagnostic = {
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  argv: string[];
  model: string | null;
  chunk?: string;
};

async function lane(key: string, repoDiff: string = diff) {
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

const diagnostic = (d: ReturnType<typeof setup>["d"], key: string): Diagnostic => {
  const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".diagnostic.json"));
  expect(files).toHaveLength(1);
  expect(files[0]).toStartWith(`lane_${key}@${tip}-`);
  return JSON.parse(readFileSync(join(d.store.root, "receipts", files[0]!), "utf8")) as Diagnostic;
};

describe("lane review diagnostics", () => {
  test("a verdict printed only to stderr is a reviewer_empty with the stderr captured", async () => {
    const { w, d } = await lane("stderr-verdict");
    w.reviewer = () => ({ code: 0, stdout: "", stderr: "VERDICT: CLEAR" });

    const error = await failed(() => reviewLane(d, "stderr-verdict"));
    expect(error.message).toContain("reviewer_empty");
    expect(d.store.laneReceipt("stderr-verdict", tip)!.verdict).toBe("reviewer_empty");
    const diag = diagnostic(d, "stderr-verdict");
    expect(diag.stdoutTail).toBe("");
    expect(diag.stderrTail).toContain("VERDICT: CLEAR");
    expect(diag.exitCode).toBe(0);
  });

  test("a non-zero exit with empty stdout keeps the exit code and stderr", async () => {
    const { w, d } = await lane("nonzero");
    w.reviewer = () => ({ code: 2, stdout: "", stderr: "provider 403" });

    const error = await failed(() => reviewLane(d, "nonzero"));
    expect(error.message).toContain("reviewer_empty");
    const receipt = d.store.laneReceipt("nonzero", tip)!;
    expect(receipt.verdict).toBe("reviewer_empty");
    expect(receipt.summary).toContain("exit 2");
    const diag = diagnostic(d, "nonzero");
    expect(diag.exitCode).toBe(2);
    expect(diag.stderrTail).toContain("provider 403");
  });

  test("a failed attempt retries once with reviewFallbackModel and the receipt names both models", async () => {
    const { w, d } = await lane("retry");
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/m" }));
    w.reviewer = (argv) =>
      argv.includes("fallback/m")
        ? { code: 0, stdout: "VERDICT: CLEAR" }
        : { code: 0, stdout: "", stderr: "primary empty" };

    expect(await reviewLane(d, "retry", "primary/m")).toEqual({ verdict: "CLEAR", base, tip });
    const calls = w.calls.filter((c) => c.cmd === "omo");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toContain("primary/m");
    expect(calls[1]!.argv).toContain("fallback/m");
    const receipt = d.store.laneReceipt("retry", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.reviewer).toContain("primary/m");
    expect(receipt.reviewer).toContain("fallback/m");
    expect(receipt.summary).toContain("retried with fallback/m");
    const diag = diagnostic(d, "retry");
    expect(diag.model).toBe("primary/m");
    expect(diag.stderrTail).toContain("primary empty");
    expect(diag.argv).toContain("primary/m");
  });

  test("an empty chunk is re-split once and every final chunk carries a verdict", async () => {
    const section = (path: string, fill: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;
    const multi =
      section("src/a.ts", "a".repeat(6_000)) +
      section("src/b.ts", "b".repeat(6_000)) +
      section("src/c.ts", "c".repeat(6_000));
    const { w, d } = await lane("resplit", multi);
    w.reviewer = (argv) => {
      const text = argv.at(-1) ?? "";
      return text.includes("src/a.ts") && text.includes("src/b.ts") && !text.includes("src/c.ts")
        ? { code: 0, stdout: "" }
        : { code: 0, stdout: "VERDICT: CLEAR" };
    };

    expect(await reviewLane(d, "resplit", "some/model")).toEqual({ verdict: "CLEAR", base, tip });
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(4);
    const receipt = d.store.laneReceipt("resplit", tip)!;
    expect(receipt.verdict).toBe("CLEAR");
    expect(receipt.reviewer).toContain("some/model");
    expect(receipt.summary).toContain("re-split");
    expect(receipt.summary).toContain("src/a.ts");
    expect(receipt.summary).toContain("src/b.ts");
    expect(receipt.summary).toContain("src/c.ts");
    expect(receipt.summary.match(/-> CLEAR/g)).toHaveLength(3);
    const diag = diagnostic(d, "resplit");
    expect(diag.stdoutTail).toBe("");
    expect(diag.chunk).toBe("1/2");
    expect(diag.model).toBe("some/model");
  });

  test("resplitChunk splits a single-file chunk by hunks", () => {
    const text =
      "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n+a\n@@ -10 +10 @@\n+b\n";
    const chunk = { index: 1, paths: ["src/x.ts"], text, bytes: Buffer.byteLength(text), lines: 2 };
    const sub = resplitChunk(chunk);
    expect(sub).toHaveLength(2);
    expect(sub[0]!.label).toContain("hunks 1-1");
    expect(sub[1]!.label).toContain("hunks 2-2");
    expect(sub[0]!.text).toContain("@@ -1");
    expect(sub[1]!.text).toContain("@@ -10");
  });

  test("a hook reviewer's failure diagnostic names the hook argv and the full diff", async () => {
    const { w, d } = await lane("hooked-fail");
    writeFileSync(
      join(d.store.root, "config.json"),
      JSON.stringify({ hooks: { reviewCommand: ["fake-review", "{diff}"] } }),
    );
    w.reviewer = () => ({ code: 0, stdout: "", stderr: "hook silent" });

    const error = await failed(() => reviewLane(d, "hooked-fail"));
    expect(error.message).toContain("hook silent");
    const receipt = d.store.laneReceipt("hooked-fail", tip)!;
    expect(receipt.verdict).toBe("reviewer_empty");
    expect(receipt.reviewer).toBe("hook: fake-review {diff}");
    const diag = diagnostic(d, "hooked-fail");
    expect(diag.model).toBeNull();
    expect(diag.argv).toEqual(["fake-review", d.store.laneDiffPath("hooked-fail", tip)]);
    expect(diag.stderrTail).toContain("hook silent");
  });
});
