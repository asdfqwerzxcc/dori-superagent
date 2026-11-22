import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { send } from "../src/inbox.ts";
import { WORKING_STALE_MS } from "../src/lane-watch.ts";
import { startLane, report } from "../src/lanes.ts";
import { setup } from "./harness-setup.ts";

const screen = (name: string) => Bun.file(join(import.meta.dir, "fixtures", "screens", `${name}.txt`)).text();

describe("a lane whose record says working while its pane is idle", () => {
  test("its held queue is delivered on the pane's idle screen, not on the lane record", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "stuck", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.screen = await screen("omo-turn");
    expect(await send(d, "stuck", "hello", "cli")).toBe("QUEUED");
    expect(pane.received).toEqual([]);
    pane.screen = await screen("omo-idle-live-monitors");
    expect(await dutyTick(d)).toContainEqual({ pane: lane.paneId, action: "flushed" });
    expect(pane.received).toEqual(["hello"]);
    expect(d.store.lane("stuck")!.status).toBe("working");
    expect(d.store.lane("stuck")!.watch).toBeDefined();
  });

  test("a pane that keeps printing holds the queue and is never demoted", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "busy", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.screen = await screen("omo-turn");
    d.store.enqueue(lane.sessionRef, { at: w.clock, from: "cli", text: "hello" });
    const at = async (min: number) => {
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };
    expect(await at(0)).toEqual([]);
    pane.screen = `## Progress\n 5 of 9 files read\n${await screen("omo-turn")}`;
    expect(await at(6)).toEqual([]);
    expect(pane.received).toEqual([]);
    expect(d.store.queued(lane.sessionRef).map((m) => m.text)).toEqual(["hello"]);
    const record = d.store.lane("busy")!;
    expect(record.status).toBe("working");
    expect(record.log.some((e) => e.kind === "demoted")).toBe(false);
    expect(record.lastActivityAt).toBe(w.clock);
  });

  test("a working lane with no output or file change for 5 minutes is demoted to waiting and logged", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "stalled", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.screen = await screen("omo-turn");
    const at = async (min: number) => {
      w.clock = lane.createdAt + min * 60_000;
      return dutyTick(d);
    };
    expect(await at(0)).toEqual([]);
    expect(d.store.lane("stalled")!.status).toBe("working");
    expect(await at(WORKING_STALE_MS / 60_000)).toContainEqual({
      lane: "stalled",
      action: "demoted",
      detail: "no output or file change for 5 min",
    });
    const record = d.store.lane("stalled")!;
    expect(record.status).toBe("waiting");
    expect(record.log.at(-1)).toMatchObject({ kind: "demoted" });
    expect(record.log.at(-1)!.text).toContain("5 min");
    pane.status = "idle";
    w.clock = lane.createdAt + 10 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "stalled", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("idle for 10 minutes");
  });

  test("a redrawing footer is not output: a quiet lane is still demoted at 5 minutes", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "footer", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const idle = await screen("omo-idle-live-monitors");
    pane.screen = idle;
    w.clock = lane.createdAt;
    expect(await dutyTick(d)).toEqual([]);
    pane.screen = idle.replace("3m ago", "4m ago").replace("12h 58m", "13h 3m");
    w.clock = lane.createdAt + 5 * 60_000;
    expect(await dutyTick(d)).toContainEqual({
      lane: "footer",
      action: "demoted",
      detail: "no output or file change for 5 min",
    });
    expect(d.store.lane("footer")!.status).toBe("waiting");
  });

  test("a demoted lane that reports again is promoted back to working", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "resumed", brief, { group: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    pane.screen = await screen("omo-idle-live-monitors");
    w.clock = lane.createdAt;
    expect(await dutyTick(d)).toEqual([]);
    w.clock = lane.createdAt + 5 * 60_000;
    expect(await dutyTick(d)).toContainEqual({ lane: "resumed", action: "demoted", detail: expect.any(String) });
    expect(d.store.lane("resumed")!.status).toBe("waiting");
    await report(d, "resumed", "checked the fixture again");
    const record = d.store.lane("resumed")!;
    expect(record.status).toBe("working");
    expect(record.demotedAt).toBeUndefined();
  });

  test("a file written in the lane worktree counts as activity when the screen is still", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "typing", brief, { group: "w1" });
    const worktree = mkdtempSync(join(tmpdir(), "dori-lane-"));
    d.store.saveLane({ ...d.store.lane("typing")!, worktree });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "working";
    pane.screen = await screen("omo-turn");
    w.clock = lane.createdAt;
    expect(await dutyTick(d)).toEqual([]);
    writeFileSync(join(worktree, "notes.md"), "progress");
    w.clock = lane.createdAt + 6 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("typing")!.status).toBe("working");
  });
});
