import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backlogDecide } from "../src/backlog.ts";
import { dutyTick } from "../src/duty.ts";
import { done, ready, report, startLane } from "../src/lanes.ts";
import { HOUR, loopTick } from "../src/loop.ts";
import { setup } from "./loop-setup.ts";

describe("hourly loop", () => {
  test("starts by priority, then age, then id, within the per-run and lane budget; skips a second run in the hour", async () => {
    const { w, d, lead, add, destructive } = setup();
    add("old-five");
    w.clock += 1000;
    add("urgent", { priority: 1 });
    w.clock += 1000;
    add("new-five");
    add("aaa-five");
    lead.received.length = 0;

    const run = await loopTick(d, { maxLanes: 3, maxStarts: 2 });
    expect(run.started).toEqual(["urgent (p1)", "old-five (p5)"]);
    expect(run.held).toEqual(["2 item(s) waiting: 1 free of 3 lanes, max 2/run"]);
    expect(d.store.item("urgent")!.status).toBe("running");
    expect(w.panes.get(d.store.lane("urgent")!.paneId)!.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(lead.received.filter((m) => m.startsWith("[START"))).toHaveLength(2);
    const loopMsg = lead.received.find((m) => m.startsWith("[LOOP"))!;
    expect(loopMsg).toContain("lanes 2/3");
    expect(loopMsg).toContain("started: urgent (p1); old-five (p5)");
    expect(d.store.runs()).toHaveLength(1);
    expect(d.store.lastRun()!.at).toBe(run.at);

    w.clock += 10 * 60_000;
    const again = await loopTick(d);
    expect(again.skipped).toBe("ran 10m ago");
    w.clock += 50 * 60_000 - 1000;
    expect((await loopTick(d)).skipped).toBe("ran 59m ago");
    w.clock -= 50 * 60_000 - 1000;
    expect(d.store.runs()).toHaveLength(1);

    const forced = await loopTick(d, { force: true, maxLanes: 3 });
    expect(forced.started).toEqual(["aaa-five (p5)"]);
    expect(forced.held).toEqual(["1 item(s) waiting: 0 free of 3 lanes, max 2/run"]);
    w.clock += HOUR;
    expect((await loopTick(d, { maxLanes: 3 })).started).toEqual([]);
    expect(destructive()).toEqual([]);
  });

  test("holds starts when lanes are full, the host is busy, or the item needs a decision", async () => {
    const { w, d, brief, add, tick } = setup();
    add("next");
    add("blocked", { priority: 1, decision: "which database?" });
    await startLane(d, "hand-a", brief, { group: "w1" });
    await startLane(d, "hand-b", brief, { group: "w1" });
    const full = await tick({ maxLanes: 2 });
    expect(full.started).toEqual([]);
    expect(full.held[0]).toContain("0 free of 2 lanes");
    expect(full.status!.adhoc).toEqual(["hand-a", "hand-b"]);

    w.host = { load1: 20, cores: 8, memFreePct: 50 };
    expect((await tick({ maxLanes: 5 })).held[0]).toBe("host busy: load 20.0 (limit 8), mem free 50%");
    expect((await tick({ maxLanes: 5, maxLoad: 10 })).held[0]).toBe("host busy: load 20.0 (limit 10), mem free 50%");
    w.host = { load1: 1, cores: 8, memFreePct: 5 };
    expect((await tick({ maxLanes: 5 })).held[0]).toContain("mem free 5%");
    w.host = { load1: 1, cores: 8, memFreePct: 50 };
    expect((await tick({ maxLanes: 5 })).started).toEqual(["next (p5)"]);
    expect(d.store.item("blocked")!.status).toBe("open");
  });

  test("sync: done lane closes the item, a lost lane reopens it and asks after two losses, a merged PR closes it", async () => {
    const { w, d, lead, add, tick } = setup();
    add("item-a");
    add("item-b");
    add("item-c");
    await tick({ maxStarts: 3 });

    const a = d.store.lane("item-a")!;
    await ready(d, "item-a", "fixed", ["note.txt"]);
    w.panes.get(a.paneId)!.status = "idle";
    await done(d, "item-a");
    // Closing the lane closes its item right away, so the next tick has nothing to reconcile or start.
    expect(d.store.item("item-a")).toMatchObject({ status: "done" });
    expect(d.store.item("item-a")!.log.at(-1)).toMatchObject({ kind: "done", text: "lane item-a done" });

    w.panes.delete(d.store.lane("item-b")!.paneId);
    const lost = d.store.lane("item-b")!;
    lost.status = "lost";
    d.store.saveLane(lost);

    await ready(d, "item-c", "PR up", ["https://github.com/acme/app/pull/9"]);
    w.gh = (argv) => ({ code: 0, stdout: JSON.stringify({ state: argv[2] === "9" ? "MERGED" : "OPEN" }) });

    const run = await tick({ maxStarts: 0 });
    expect(run.synced).toEqual(["item-b reopened (lane lost, attempt 1)", "item-c done (PR merged)"]);
    expect(run.findings).toContain("item-c READY and its PR merged: dori done item-c");
    expect(d.store.item("item-b")).toMatchObject({ status: "open", attempts: 1 });
    expect(d.store.item("item-b")!.decision).toBeUndefined();

    // D16: a lost key is kept as evidence and refuses a restart until the operator drops it.
    expect(await done(d, "item-b", { drop: "lost" })).toBe("dropped: lost");
    expect((await tick()).started).toEqual(["item-b (p5)"]);
    const again = d.store.lane("item-b")!;
    again.status = "lost";
    d.store.saveLane(again);
    const second = await tick();
    expect(d.store.item("item-b")!.decision).toBe("lane lost 2 times; retry, re-brief or drop?");
    expect(second.started).toEqual([]);
    expect(lead.received.at(-1)).toContain("[DECIDE item-b] lane lost 2 times");

    w.gh = () => ({ code: 1, stdout: "rate limited" });
    add("item-d", { source: "acme/app#4" });
    const ghDown = await tick();
    expect(ghDown.findings.some((f) => f.startsWith("gh: "))).toBe(true);
    expect(d.store.lastRun()!.at).toBe(ghDown.at);
  });

  test("done closes the item its lane served, and a done item is never started again", async () => {
    const { w, d, add } = setup();
    add("landed");
    await loopTick(d, { force: true });
    const lane = d.store.lane("landed")!;
    expect(lane.item).toBe("landed");
    expect(d.store.item("landed")!.status).toBe("running");
    await ready(d, "landed", "done", ["file:///x"]);
    w.panes.get(lane.paneId)!.status = "idle";
    await done(d, "landed");
    const item = d.store.item("landed")!;
    expect(item.status).toBe("done");
    expect(item.log.at(-1)).toMatchObject({ kind: "done", text: "lane landed done" });

    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    expect(d.store.item("landed")!.status).toBe("done");
  });

  test("done closes an open item served by a lane the loop did not start", async () => {
    const { w, d, add, tick } = setup();
    add("manual-item");
    const lane = await startLane(d, "manual-item", d.store.item("manual-item")!.brief, { group: "w1" });
    expect(lane.item).toBe("manual-item");
    // The observed bug: a hand-started lane leaves the item open, so the loop saw it as fresh work after the landing.
    expect(d.store.item("manual-item")!.status).toBe("open");
    await ready(d, "manual-item", "landed", ["file:///x"]);
    w.panes.get(lane.paneId)!.status = "idle";
    await done(d, "manual-item");
    expect(d.store.item("manual-item")!.status).toBe("done");

    const run = await tick();
    expect(run.started).toEqual([]);
    expect(d.store.item("manual-item")!.status).toBe("done");
  });

  test("done --drop closes the item as dropped and the loop leaves it alone", async () => {
    const { d, add } = setup();
    add("abandoned");
    await loopTick(d, { force: true });
    expect(d.store.item("abandoned")!.status).toBe("running");
    await done(d, "abandoned", { drop: "not worth it" });
    const item = d.store.item("abandoned")!;
    expect(item.status).toBe("dropped");
    expect(item.log.at(-1)).toMatchObject({ kind: "drop", text: "lane abandoned dropped: not worth it" });

    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    expect(d.store.item("abandoned")!.status).toBe("dropped");
  });

  test("audit flags stale, long-waiting, unclosed-READY and vanished lanes without touching them", async () => {
    const { w, d, brief, tick, destructive } = setup();
    const quiet = await startLane(d, "quiet", brief, { group: "w1" });
    const busy = await startLane(d, "busy", brief, { group: "w1" });
    const wait = await startLane(d, "wait-ci", brief, { group: "w1" });
    const fin = await startLane(d, "finished", brief, { group: "w1" });
    const gone = await startLane(d, "vanished", brief, { group: "w1" });
    await startLane(d, "fresh", brief, { group: "w1" });
    await report(d, "wait-ci", "WAITING: CI on acme/app#3", "waiting");
    await ready(d, "finished", "done", ["https://github.com/acme/app/pull/3"]);
    for (const l of [quiet, wait, fin]) w.panes.get(l.paneId)!.status = "idle";
    w.panes.get(busy.paneId)!.status = "working";
    w.panes.delete(gone.paneId);
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ state: "OPEN" }) });

    w.clock += 30 * 60_000;
    expect((await tick({ maxStarts: 0 })).findings).toEqual(["vanished pane " + gone.paneId + " is gone"]);
    w.clock += 4 * HOUR;
    await dutyTick(d);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    const lanesBefore = readdirSync(join(d.store.root, "lanes")).map((f) =>
      readFileSync(join(d.store.root, "lanes", f), "utf8"),
    );
    const run = await tick({ maxStarts: 0 });
    expect(run.findings.sort()).toEqual([
      "busy working, no report for 4h",
      "finished READY 4h ago, not closed: dori done finished",
      "fresh working, no report for 4h",
      "quiet working, no report for 4h",
      "wait-ci waiting 4h on: WAITING: CI on acme/app#3",
    ]);
    const lanesAfter = readdirSync(join(d.store.root, "lanes")).map((f) =>
      readFileSync(join(d.store.root, "lanes", f), "utf8"),
    );
    expect(lanesAfter).toEqual(lanesBefore);
    expect(destructive()).toEqual([]);
  });

  test("a decision is asked once, reminded once after 6 hours, then left alone until answered", async () => {
    const { w, d, lead, add } = setup();
    add("pick-db", { decision: "postgres or sqlite?" });
    const at = async (h: number) => {
      w.clock += h * HOUR;
      return loopTick(d);
    };
    expect((await at(0)).asked).toEqual([
      "[DECIDE pick-db] postgres or sqlite? -> dori backlog decide pick-db --text '...' | dori backlog drop pick-db",
    ]);
    expect((await at(1)).asked).toEqual([]);
    expect((await at(5)).asked[0]).toStartWith("(reminder) [DECIDE pick-db]");
    expect((await at(6)).asked).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[DECIDE pick-db]"))).toHaveLength(2);
    backlogDecide(d, "pick-db", "sqlite");
    expect((await at(1)).started).toEqual(["pick-db (p5)"]);
  });

  test("failed lane starts are recorded, each uses a slot, and the run still reports what is waiting; with no lead nothing starts", async () => {
    const failing = setup({
      exec: (inner) => async (cmd, argv) =>
        cmd === "herdr" && argv[0] === "tab" ? { code: 1, stdout: "", stderr: "server down" } : inner(cmd, argv),
    });
    failing.add("one");
    failing.add("two");
    failing.add("three");
    const run = await failing.tick({ maxStarts: 2 });
    expect(run.started).toEqual([]);
    expect(run.findings).toEqual([
      expect.stringContaining("start one failed: herdr tab create"),
      expect.stringContaining("start three failed: herdr tab create"),
    ]);
    expect(run.held).toEqual(["1 item(s) waiting: 5 free of 5 lanes, max 2/run"]);
    expect(failing.d.store.item("one")).toMatchObject({ status: "open", attempts: 0, startFailures: 1 });
    expect(failing.d.store.lastRun()!.at).toBe(run.at);
    expect(readdirSync(join(failing.d.store.root, "loop"))).not.toContain("lock");

    const headless = setup({ lead: false });
    headless.add("one");
    const quiet = await headless.tick();
    expect(quiet.held).toEqual(["no lead pane registered"]);
    expect(quiet.started).toEqual([]);
    expect(headless.d.store.runs()).toHaveLength(1);
  });

  test("an item whose start keeps failing becomes a question and stops blocking the items behind it", async () => {
    const { w, d, lead, add } = setup();
    add("broken", { priority: 1 });
    add("healthy", { priority: 5 });
    rmSync(d.store.item("broken")!.brief);
    const hourly = async () => {
      w.clock += HOUR;
      return loopTick(d, { maxStarts: 1 });
    };
    expect((await hourly()).findings[0]).toStartWith("start broken failed");
    const second = await hourly();
    expect(second.findings[0]).toStartWith("start broken failed");
    expect(d.store.item("broken")!.decision).toStartWith("lane start failed 2 times");
    expect(second.asked[0]).toStartWith("[DECIDE broken] lane start failed 2 times");
    expect((await hourly()).started).toEqual(["healthy (p5)"]);
    expect(lead.received.some((m) => m.includes("[DECIDE broken]"))).toBe(true);
  });
});

describe("hardening", () => {
  test("a lane that opened but whose [START] could not reach the lead counts as started", async () => {
    const { d, add, tick } = setup({
      exec: (inner) => async (cmd, argv) =>
        cmd === "herdr" && argv[0] === "agent" && argv[2] === "w1:p1"
          ? { code: 1, stdout: "", stderr: "lead pane hung" }
          : inner(cmd, argv),
    });
    add("solo");
    const run = await tick({ maxStarts: 1 });
    expect(run.started).toEqual(["solo (p5)"]);
    expect(d.store.item("solo")!.status).toBe("running");
    expect(run.findings.some((f) => f.startsWith("solo started in ") && f.includes("lead was not told"))).toBe(true);
    expect(run.findings.some((f) => f.startsWith("report to the lead failed"))).toBe(true);
    expect(d.store.lastRun()!.findings).toEqual(run.findings);
    const records = d.store.runs();
    expect(records).toHaveLength(1);
    expect(JSON.parse(readFileSync(d.store.loopPath(`runs/${records[0]}`), "utf8")).findings).toEqual(run.findings);
  });
});
