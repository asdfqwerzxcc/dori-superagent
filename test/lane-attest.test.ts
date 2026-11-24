import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { reviewJobFor } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

async function world() {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  await startLane(s.d, "fix-login", s.brief, { group: "w1" });
  await ready(s.d, "fix-login", "fixed", ["file:///fix-login"]);
  repo.head = tip;
  return s;
}

const queue = (d: Deps) => captureIo(() => main(["review", "--lane", "fix-login"], d));
const attest = (d: Deps, extra: readonly string[]) =>
  captureIo(() => main(["review", "fix-login", "--attest", ...extra], d));
const fully = ["--verdict", "CLEAR", "--reviewer", "omo-native-gate-reviewer", "--evidence", "report.md"];

describe("lane attestation", () => {
  test("records the reviewer verdict with the receipt schema and consumes the request", async () => {
    const { d } = await world();
    await queue(d);
    const out = await attest(d, [...fully, "--summary", "no findings"]);
    expect(out).toEqual({ code: 0, out: `ATTESTED fix-login tip=${tip} verdict=CLEAR` });
    const receipt = JSON.parse(readFileSync(join(d.store.root, "receipts", `lane_fix-login@${tip}.json`), "utf8"));
    expect(receipt).toEqual({
      lane: "fix-login",
      verdict: "CLEAR",
      base,
      tip,
      brief: d.store.lane("fix-login")!.brief,
      reviewer: "omo-native-gate-reviewer",
      at: d.now(),
      summary: "no findings\nreport.md",
      evidence: ["report.md"],
    });
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("--attest requires a verdict, a reviewer and at least one evidence link", async () => {
    const { d } = await world();
    await expect(main(["review", "fix-login", "--attest", "--reviewer", "r", "--evidence", "e"], d)).rejects.toThrow(
      "--verdict CLEAR|BLOCK",
    );
    await expect(main(["review", "fix-login", "--attest", "--verdict", "CLEAR", "--evidence", "e"], d)).rejects.toThrow(
      "--reviewer",
    );
    await expect(main(["review", "fix-login", "--attest", "--verdict", "CLEAR", "--reviewer", "r"], d)).rejects.toThrow(
      "--evidence",
    );
  });

  test("--lane <key> --attest writes the same receipt", async () => {
    const { d } = await world();
    const out = await captureIo(() => main(["review", "--lane", "fix-login", "--attest", ...fully], d));
    expect(out).toEqual({ code: 0, out: `ATTESTED fix-login tip=${tip} verdict=CLEAR` });
    expect(d.store.laneReceipt("fix-login", tip)?.verdict).toBe("CLEAR");
  });

  test("BLOCK is written, done refuses it, and a later CLEAR never replaces it", async () => {
    const { d } = await world();
    const blocked = await attest(d, [
      "--verdict",
      "BLOCK",
      "--reviewer",
      "omo-native-gate-reviewer",
      "--evidence",
      "report.md",
    ]);
    expect(blocked).toEqual({ code: 1, out: `ATTESTED fix-login tip=${tip} verdict=BLOCK` });
    expect(d.store.laneReceipt("fix-login", tip)?.verdict).toBe("BLOCK");
    await expect(done(d, "fix-login")).rejects.toThrow("is BLOCK");

    const kept = await attest(d, fully);
    expect(kept).toEqual({ code: 1, out: `ATTESTED fix-login tip=${tip} verdict=BLOCK (kept)` });
    expect(d.store.laneReceipt("fix-login", tip)?.verdict).toBe("BLOCK");
  });

  test("a lane with no commits cannot be attested", async () => {
    const { w, d, brief } = setup();
    fakeGit(w, { head: base, mergeBase: base, diff });
    await startLane(d, "empty", brief, { group: "w1" });
    await expect(
      main(
        [
          "review",
          "empty",
          "--attest",
          "--verdict",
          "CLEAR",
          "--reviewer",
          "omo-native-gate-reviewer",
          "--evidence",
          "report.md",
        ],
        d,
      ),
    ).rejects.toThrow("nothing to review");
  });
});
