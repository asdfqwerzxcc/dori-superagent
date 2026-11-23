import { describe, expect, test } from "bun:test";
import { status } from "../src/cli-up.ts";
import { backlogAdd } from "../src/backlog.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { attestLane } from "../src/review-lane-cli.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

async function world(keys: readonly string[] = ["fix-login"]) {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  for (const key of keys) {
    await startLane(s.d, key, s.brief, { group: "w1" });
    await ready(s.d, key, "fixed", [`file:///${key}`]);
  }
  repo.head = tip;
  return { ...s, repo };
}

const attest = (d: Parameters<typeof attestLane>[0], key: string, verdict: "CLEAR" | "BLOCK" = "CLEAR") =>
  attestLane(d, key, { verdict, reviewer: "omo-native-gate-reviewer", evidence: ["file:///report"] });

describe("lane review gate", () => {
  test("done refuses a tip without a CLEAR receipt, then closes after the attestation", async () => {
    const { w, d } = await world();
    await expect(done(d, "fix-login")).rejects.toThrow("run: dori review --lane fix-login");
    expect(d.store.lane("fix-login")!.status).toBe("ready");

    await attest(d, "fix-login");
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
    expect(w.panes.has(d.store.lane("fix-login")!.paneId)).toBe(false);
  });

  test("a lane that committed nothing closes; a lane without a receipt closes only by --drop", async () => {
    const { w, d, brief } = setup();
    const repo: Repo = { head: base, mergeBase: base, diff };
    fakeGit(w, repo);
    await startLane(d, "investigate", brief, { group: "w1" });
    await ready(d, "investigate", "nothing to change", ["file:///notes.md"]);
    expect(await done(d, "investigate")).toBeUndefined();

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

  test("done closes the backlog item with the reviewed tip and its CLEAR receipt", async () => {
    const { d, brief } = await world(["fix-login"]);
    d.store.saveLane({ ...d.store.lane("fix-login")!, item: "fix-login" });
    backlogAdd(d, "fix-login", brief, { cwd: d.store.root });
    await attest(d, "fix-login");
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.item("fix-login")!.status).toBe("done");
    expect(d.store.item("fix-login")!.log.at(-1)).toMatchObject({
      kind: "done",
      text: `lane fix-login done at ${tip.slice(0, 12)} (CLEAR receipt lane_fix-login@${tip})`,
    });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
  });

  test("status prints reviewed, BLOCK or no receipt beside each lane", async () => {
    const { d } = await world(["green", "red", "plain"]);
    for (const [key, verdict] of [
      ["green", "CLEAR"],
      ["red", "BLOCK"],
    ] as const)
      d.store.saveLaneReceipt({
        lane: key,
        verdict,
        base,
        tip,
        brief: d.store.lane(key)!.brief,
        reviewer: "omo-native-gate-reviewer",
        at: 1,
        summary: "",
      });
    const { out } = await captureIo(async () => {
      await status(d);
      return 0;
    });
    const row = (key: string) => out.split("\n").find((line) => line.startsWith(key))!;
    expect(row("green")).toContain("review=reviewed");
    expect(row("red")).toContain("review=BLOCK");
    expect(row("plain")).toContain("review=no receipt");
  });
});
