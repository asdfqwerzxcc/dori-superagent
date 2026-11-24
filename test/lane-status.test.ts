import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { done, ready, report, startLane } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import { Store } from "../src/store.ts";
import { setup } from "./harness-setup.ts";
import { repoWorld } from "./lanes-setup.ts";

const readLane = (d: Deps, key: string) => {
  const lane = d.store.lane(key);
  if (lane === undefined) throw new Error(`no lane ${key}`);
  return lane;
};

/** git answers as if the lane checkout had been removed: no HEAD, and `merge-base --is-ancestor` returns `ancestorCode`. */
const removedWorktreeGit = (ancestorCode: number) => (argv: readonly string[]) => {
  const args = argv[0] === "-C" ? argv.slice(2) : argv;
  if (args[0] === "rev-parse") return { code: 128, stdout: "", stderr: "fatal: cannot change to worktree" };
  return { code: args[0] === "merge-base" ? ancestorCode : 0, stdout: "", stderr: "" };
};

describe("a closed lane stays closed", () => {
  test("a stale ready snapshot cannot overwrite done, and the done entry survives", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "closed", brief, { group: "w1" });
    await ready(d, "closed", "fixed it", ["https://example.test/pull/1"]);
    const stale = readLane(d, "closed");
    expect(stale.status).toBe("ready");

    await done(d, "closed");
    // A snapshot read before the close must not put the lane back on the board.
    expect(() => d.store.saveLane(stale)).toThrow(Refusal);
    expect(() => d.store.saveLane(stale)).toThrow(/already done/);

    const record = readLane(d, "closed");
    expect(record.status).toBe("done");
    expect(record.final?.text).toBe("fixed it");
    expect(record.log.some((e) => e.kind === "done")).toBe(true);
    expect(lead.received.at(-1)).toContain("[READY closed]");
  });

  test("a stale snapshot cannot overwrite a dropped lane either", async () => {
    const { d, brief } = setup();
    await startLane(d, "abandoned", brief, { group: "w1" });
    const stale = readLane(d, "abandoned");
    await done(d, "abandoned", { drop: "superseded" });

    expect(() => d.store.saveLane(stale)).toThrow(/already dropped/);
    const record = readLane(d, "abandoned");
    expect(record.status).toBe("dropped");
    expect(record.log.some((e) => e.kind === "dropped" && e.text === "superseded")).toBe(true);
  });

  test("ready and report after done are refused: a closed lane takes no new answer", async () => {
    const { d, brief } = setup();
    await startLane(d, "late", brief, { group: "w1" });
    await ready(d, "late", "final", ["https://example.test/pull/2"]);
    await done(d, "late");

    await expect(ready(d, "late", "again", ["https://example.test/pull/3"])).rejects.toThrow("lane late is done");
    await expect(report(d, "late", "a late note")).rejects.toThrow("lane late is done");
    expect(readLane(d, "late").final?.text).toBe("final");
  });

  test("report after READY is an addendum, never a downgrade, and done still closes", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "addendum", brief, { group: "w1" });
    await ready(d, "addendum", "final", ["https://example.test/pull/4"]);

    await report(d, "addendum", "extra evidence for the audit", "waiting");
    const record = readLane(d, "addendum");
    expect(record.status).toBe("ready");
    expect(record.final?.text).toBe("final");
    expect(record.log.at(-1)).toMatchObject({ kind: "report", text: "extra evidence for the audit" });
    // The lane stays READY, so the lead must not be told it went back to waiting.
    expect(lead.received.at(-1)).toBe("[REPORT addendum] extra evidence for the audit");

    await done(d, "addendum");
    expect(readLane(d, "addendum").status).toBe("done");
  });

  test("a done key can start a new lane: the revive is explicit", async () => {
    const { d, brief } = setup();
    await startLane(d, "reused", brief, { group: "w1" });
    await ready(d, "reused", "final", ["https://example.test/pull/5"]);
    await done(d, "reused");

    const again = await startLane(d, "reused", brief, { group: "w1" });
    expect(again.status).toBe("working");
    expect(readLane(d, "reused").log.map((e) => e.kind)).toEqual(["start"]);
  });
});

describe("a restart keeps a closed lane closed", () => {
  test("a fresh store reads done, duty leaves it alone, and it refuses stale snapshots", async () => {
    const { d, brief } = setup();
    await startLane(d, "survivor", brief, { group: "w1" });
    await ready(d, "survivor", "final", ["https://example.test/pull/6"]);
    const stale = readLane(d, "survivor");
    await done(d, "survivor");

    // A restart builds a new Store over the same home; the record, not the process, is the truth.
    const restarted = new Store(d.store.root);
    expect(restarted.lane("survivor")!.status).toBe("done");
    const afterRestart: Deps = { ...d, store: restarted };
    const events = await dutyTick(afterRestart);
    expect(events.some((e) => e.lane === "survivor")).toBe(false);

    const record = restarted.lane("survivor")!;
    expect(record.status).toBe("done");
    expect(record.log.at(-1)!.kind).toBe("done");
    expect(() => restarted.saveLane(stale)).toThrow(Refusal);
    expect(restarted.lane("survivor")!.status).toBe("done");
  });
});

describe("done without a worktree", () => {
  test("a lane whose recorded tip is already on main closes as landed instead of needing --drop", async () => {
    const { w, d, brief } = repoWorld();
    const lane = await startLane(d, "landed", brief, { group: "w1" });
    await ready(d, "landed", "final", ["https://example.test/pull/7"]);
    w.git = removedWorktreeGit(0);

    const note = await done(d, "landed");
    expect(note).toContain("is already on main");
    const record = readLane(d, "landed");
    expect(record.status).toBe("done");
    expect(record.log.at(-1)).toMatchObject({ kind: "done" });
    expect(w.panes.has(lane.paneId)).toBe(false);
  });

  test("a missing worktree whose tip is not on main refuses and names the --drop exit", async () => {
    const { w, d, brief } = repoWorld();
    await startLane(d, "gone-tree", brief, { group: "w1" });
    await ready(d, "gone-tree", "final", ["https://example.test/pull/8"]);
    w.git = removedWorktreeGit(1);

    const failure: unknown = await done(d, "gone-tree").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Error).message).toContain("gone");
    expect((failure as Error).message).toContain("dori done --drop gone-tree --reason");
    expect(readLane(d, "gone-tree").status).toBe("ready");
  });
});
