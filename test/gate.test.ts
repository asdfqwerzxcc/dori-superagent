import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeGate } from "../src/gate.ts";
import { review } from "../src/review-pr.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

// Windows has no POSIX mode bits: statSync reports a synthesized 0o666 for any writable file, whatever chmod asked for.
// The private-diagnostic assertion is therefore a POSIX check; the content assertions above it run on every platform.
const posixModes = process.platform !== "win32";

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  type GhResult = { readonly code: number; readonly stdout: string; readonly stderr?: string };
  const noChecks: GhResult = { code: 1, stdout: "", stderr: "no checks reported on the 'main' branch" };
  const green: GhResult = { code: 0, stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) };

  function gh(w: World, checks: unknown[] | GhResult = green, workflows: number | GhResult = 1) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head, title: "t", body: "b" }) };
      if (argv[1] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+line\n" };
      if (argv[1] === "checks") return Array.isArray(checks) ? { code: 0, stdout: JSON.stringify(checks) } : checks;
      if (argv[0] === "api" && argv[1]?.endsWith("/actions/workflows"))
        return typeof workflows === "number" ? { code: 0, stdout: `${workflows}\n` } : workflows;
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt or with red checks; allowed at CLEAR + green or no checks", async () => {
    const { w, d } = setup();
    gh(w, noChecks, 0);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    gh(
      w,
      [
        { name: "test", bucket: "fail" },
        { name: "lint", bucket: "pass" },
      ],
      1,
    );
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }], 1);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("skipped");
    gh(
      w,
      [
        { name: "test", bucket: "pass" },
        { name: "docs", bucket: "skipping" },
      ],
      1,
    );
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(
      w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome),
    ).toEqual(["no_receipt", "review_block", "merged", "checks_red", "checks_red", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a repo with workflows and no reported checks refuses", async () => {
    const { w, d } = setup();
    gh(w, noChecks, 1);
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("1 workflow");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("a gh failure or unreadable output is a refusal", async () => {
    const { w, d } = setup();
    gh(w, { code: 1, stdout: "", stderr: "HTTP 502: bad gateway" }, 1);
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("HTTP 502");
    gh(w, { code: 0, stdout: "not json" }, 1);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("unreadable");
    gh(w, { code: 0, stdout: "[]" }, 1);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("empty list");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("a workflow lookup failure refuses", async () => {
    const { w, d } = setup();
    gh(w, noChecks, { code: 1, stdout: "", stderr: "HTTP 500: workflows unavailable" });
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("HTTP 500");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("an unreadable workflow count refuses instead of merging", async () => {
    const { w, d } = setup();
    gh(w, noChecks, { code: 0, stdout: "" });
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("(empty or whitespace)");
    gh(w, noChecks, { code: 0, stdout: "  \n" });
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("(empty or whitespace)");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("pending checks refuse", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "pending" }], 1);
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=pending");
    expect(w.calls.some((call) => call.cmd === "gh" && call.argv[1] === "merge")).toBe(false);
  });

  test("all-skipped checks with zero workflows are checks=none", async () => {
    const { w, d } = setup();
    gh(w, [{ name: "test", bucket: "skipping" }], 0);
    w.reviewer = () => ({ code: 0, stdout: "ok\nVERDICT: CLEAR" });
    await review(d, "o/r#7");
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
  });

  test("a reviewer that never answers is retried once on the configured fallback model", async () => {
    const { w, d } = setup();
    gh(w, noChecks, 0);
    writeFileSync(
      join(d.store.root, "config.json"),
      JSON.stringify({ reviewModel: "primary/model", reviewFallbackModel: "fallback/model" }),
    );
    let call = 0;
    w.reviewer = () =>
      ++call === 1 ? { code: 0, stdout: "provider refused" } : { code: 0, stdout: "ok\nVERDICT: CLEAR" };
    expect((await review(d, "o/r#9")).verdict).toBe("CLEAR");
    expect(d.store.receipt("o/r#9", head)!.model).toBe("fallback/model (fallback)");
    expect(w.calls.filter((c) => c.argv.includes("--model")).map((c) => c.argv[c.argv.indexOf("--model") + 1])).toEqual(
      ["fallback/model"],
    );
  });

  test("exit 0 without a VERDICT line: bounded stdout tail kept privately, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    const lines = Array.from({ length: 205 }, (_, i) => `line-${i + 1}`);
    w.reviewer = () => ({ code: 0, stdout: lines.join("\n") });
    const failure: unknown = await review(d, "o/r#8").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    expect(name).toStartWith(`o__r_8@${head}`);
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("no VERDICT");
    expect(failure.message).toContain(diagnostic);
    if (posixModes) expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8").split("\n")).toEqual(lines.slice(5));
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });

  test("nonzero exit without a VERDICT line: stdout tail kept too, exit code in the error, no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 9, stdout: "partial reviewer output" });
    const failure: unknown = await review(d, "o/r#9").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    const name = files[0];
    if (!name || !(failure instanceof Error)) throw new Error("missing diagnostic file or review error");
    const diagnostic = join(d.store.root, "receipts", name);
    expect(failure.message).toContain("reviewer exited 9");
    expect(failure.message).toContain(diagnostic);
    expect(readFileSync(diagnostic, "utf8")).toBe("partial reviewer output");
    if (posixModes) expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  });
});
