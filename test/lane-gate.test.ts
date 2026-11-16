import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { status } from "../src/cli-up.ts";
import { reviewLane } from "../src/lane-gate.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const posixModes = process.platform !== "win32";
const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

describe("lane review gate", () => {
  test("review --lane pins the tip, saves the diff and writes a CLEAR receipt", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    expect(lane.baseSha).toBe(base);
    expect(lane.tipSha).toBe(base);

    repo.head = tip;
    w.reviewer = () => ({ code: 0, stdout: "LOW src/x.ts:1 nit\nVERDICT: CLEAR" });
    expect(await reviewLane(d, "fix-login", "some/model")).toEqual({ verdict: "CLEAR", base, tip });

    const receiptPath = join(d.store.root, "receipts", `lane_fix-login@${tip}.json`);
    expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
      lane: "fix-login",
      verdict: "CLEAR",
      base,
      tip,
      brief: lane.brief,
      reviewer: "omo -p --no-session --model some/model",
      at: d.now(),
      summary: "LOW src/x.ts:1 nit\nVERDICT: CLEAR",
    });
    expect(readFileSync(d.store.laneDiffPath("fix-login", tip), "utf8")).toBe(diff);
    const reviewer = w.calls.find((c) => c.cmd === "omo")!;
    expect(reviewer.argv.at(-1)).toContain(`lane's goal is in its brief: ${lane.brief}`);
    expect(reviewer.argv.at(-1)).toContain(d.store.laneDiffPath("fix-login", tip));
    expect(d.store.lane("fix-login")!.tipSha).toBe(tip);
    expect(w.usage.at(-1)).toEqual({ name: "dori.review_completed", verdict: "CLEAR" });
  });

  test("a BLOCK receipt is written; a reviewer with no VERDICT leaves only the private diagnostic", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "blocked", brief, { group: "w1" });
    repo.head = tip;
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/x.ts:1 bug\nVERDICT: BLOCK" });
    expect((await reviewLane(d, "blocked")).verdict).toBe("BLOCK");
    expect(d.store.laneReceipt("blocked", tip)).toMatchObject({ verdict: "BLOCK", base, tip });

    const second = setup();
    const repo2: Repo = { head: base, mergeBase: base, diff };
    fakeGit(second.w, repo2);
    await startLane(second.d, "quiet", second.brief, { group: "w1" });
    repo2.head = tip;
    second.w.reviewer = () => ({ code: 0, stdout: "no verdict here" });
    const failure: unknown = await reviewLane(second.d, "quiet").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    const files = readdirSync(join(second.d.store.root, "receipts")).filter((n) => n.endsWith(".noverdict.txt"));
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith(`lane_quiet@${tip}-`);
    const diagnostic = join(second.d.store.root, "receipts", files[0]!);
    expect((failure as Error).message).toContain("no VERDICT");
    expect((failure as Error).message).toContain(diagnostic);
    if (posixModes) expect(statSync(diagnostic).mode & 0o777).toBe(0o600);
    expect(readFileSync(diagnostic, "utf8")).toBe("no verdict here");
    expect(second.d.store.laneReceipt("quiet", tip)).toBeUndefined();
    expect(second.d.store.lane("quiet")!.tipSha).toBe(base);
  });

  test("done refuses a tip without a CLEAR receipt, then closes it after the review", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "fixed", ["file:///x"]);
    repo.head = tip;
    await expect(done(d, "fix-login")).rejects.toThrow("run: dori review --lane fix-login");
    expect(d.store.lane("fix-login")!.status).toBe("ready");
    expect(w.panes.has(lane.paneId)).toBe(true);

    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    await reviewLane(d, "fix-login");
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("a lane that committed nothing closes; a lane without a receipt closes only by --drop", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "investigate", brief, { group: "w1" });
    await ready(d, "investigate", "nothing to change", ["file:///notes.md"]);
    expect(await done(d, "investigate")).toBeUndefined();
    expect(d.store.lane("investigate")!.status).toBe("done");

    await startLane(d, "unreviewed", brief, { group: "w1" });
    await ready(d, "unreviewed", "done", ["file:///x"]);
    repo.head = tip;
    await expect(done(d, "unreviewed")).rejects.toThrow("no review receipt");
    expect(d.store.lane("unreviewed")!.status).toBe("ready");

    expect(await done(d, "unreviewed", { drop: "unreviewed" })).toBe("dropped: unreviewed");
    expect(d.store.lane("unreviewed")!.status).toBe("dropped");
    expect(d.store.lane("unreviewed")!.log.at(-1)).toMatchObject({ kind: "dropped", text: "unreviewed" });
    const gits = w.calls.filter((c) => c.cmd === "git").map((c) => c.argv.join(" "));
    expect(gits).not.toContain("-C /repo merge --ff-only lane/unreviewed");
  });

  test("a lane from before the gate closes with an explicit note, never a silent pass", async () => {
    const { d, brief } = setup();
    await startLane(d, "legacy", brief, { group: "w1" });
    await ready(d, "legacy", "done", ["file:///x"]);
    expect(await done(d, "legacy")).toBe("no review gate: lane legacy has no recorded base commit");
  });

  test("status prints reviewed, BLOCK or no receipt beside each lane", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    for (const key of ["green", "red", "plain"]) await startLane(d, key, brief, { group: "w1" });
    repo.head = tip;
    for (const [key, verdict] of [
      ["green", "CLEAR"],
      ["red", "BLOCK"],
    ] as const)
      d.store.saveLaneReceipt({ lane: key, verdict, base, tip, brief, reviewer: "omo", at: 1, summary: "" });
    const { out } = await captureIo(async () => {
      await status(d);
      return 0;
    });
    const row = (key: string) => out.split("\n").find((l) => l.startsWith(key))!;
    expect(row("green")).toContain("review=reviewed");
    expect(row("red")).toContain("review=BLOCK");
    expect(row("plain")).toContain("review=no receipt");
  });

  test("hooks.reviewCommand gets the pinned diff, brief, base and tip, not the raw placeholders", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    const lane = await startLane(d, "hooked", brief, { group: "w1" });
    repo.head = tip;
    writeFileSync(
      join(d.store.root, "config.json"),
      JSON.stringify({
        hooks: { reviewCommand: ["hook-review", "{diff}", "{brief}", "{base}", "{tip}", "{lane}", "{repo}"] },
      }),
    );
    let seen: readonly string[] = [];
    w.reviewer = (argv) => {
      seen = argv;
      return { code: 0, stdout: "VERDICT: CLEAR" };
    };
    await reviewLane(d, "hooked");
    expect(seen).toEqual([
      d.store.laneDiffPath("hooked", tip),
      lane.brief,
      base,
      tip,
      "hooked",
      join(d.store.root, "worktrees", "hooked"),
    ]);
    expect(d.store.laneReceipt("hooked", tip)!.reviewer).toBe(
      "hook: hook-review {diff} {brief} {base} {tip} {lane} {repo}",
    );
  });

  test("dori review --lane prints the tip and exits by verdict; a PR plus --lane is refused", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "fix-login", brief, { group: "w1" });
    await ready(d, "fix-login", "fixed", ["file:///x"]);
    repo.head = tip;
    w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
    expect(await captureIo(() => main(["review", "--lane", "fix-login"], d))).toEqual({
      code: 0,
      out: `REVIEW_LANE fix-login tip=${tip} verdict=CLEAR`,
    });
    await expect(main(["review", "o/r#1", "--lane", "fix-login"], d)).rejects.toThrow("not both");
    await expect(main(["done", "fix-login", "--force"], d)).rejects.toThrow("no longer takes --force");
    expect((await captureIo(() => main(["done", "fix-login"], d))).out).toBe("DONE fix-login");
  });
});
