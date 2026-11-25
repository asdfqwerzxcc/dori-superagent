import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { review } from "../src/review-pr.ts";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

const head = "a".repeat(40);
const posixModes = process.platform !== "win32";
const reviewText = (d: { store: { root: string } }, pr: string, sha: string): string =>
  join(d.store.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.review.txt`);

function gh(w: World): void {
  w.gh = (argv) => {
    if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head, title: "t", body: "b" }) };
    if (argv[1] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+line\n" };
    return { code: 1, stdout: "" };
  };
}

describe("review receipt diagnostics", () => {
  test("a long reviewer report keeps its head and tail in the receipt and saves the full report", async () => {
    const { w, d } = setup();
    gh(w);
    const stdout = `HIGH src/a.ts:1 missing guard\n${"x".repeat(80_000)}\nVERDICT: CLEAR`;
    w.reviewer = () => ({ code: 0, stdout });
    expect((await review(d, "o/r#7")).verdict).toBe("CLEAR");

    const receipt = d.store.receipt("o/r#7", head);
    if (receipt === undefined) throw new Error("no receipt");
    expect(receipt.summary).toContain("HIGH src/a.ts:1 missing guard");
    expect(receipt.summary).toContain("VERDICT: CLEAR");
    expect(receipt.summary.length).toBeLessThan(stdout.length);

    const path = reviewText(d, "o/r#7", head);
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("HIGH src/a.ts:1 missing guard");
    expect(saved).toContain("VERDICT: CLEAR");
    expect(Buffer.byteLength(saved, "utf8")).toBeLessThanOrEqual(65_600);
    if (posixModes) expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
