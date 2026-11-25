import { describe, expect, test } from "bun:test";
import { dutyTick } from "../src/duty.ts";
import { startLane } from "../src/lanes.ts";
import { href } from "./fake.ts";
import { setup } from "./harness-setup.ts";

describe("duty inbox targets", () => {
  test("a queued message for a lost lane's pane is dropped once, not retried every tick", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "dead-pane", brief, { group: "w1" });
    // An earlier tick saw the pane disappear and marked the lane lost. A lost lane is terminal (`dori start`
    // refuses its key), so no pane will ever read this message.
    w.panes.delete(lane.paneId);
    const lost = d.store.lane("dead-pane")!;
    d.store.saveLane({
      ...lost,
      status: "lost",
      log: [...lost.log, { at: w.clock, kind: "lost", text: "pane disappeared without READY" }],
    });
    d.store.enqueue(lane.sessionRef, { at: w.clock, from: "cli", text: "undeliverable" });

    const first = await dutyTick(d);
    expect(first.filter((e) => e.pane === lane.paneId)).toEqual([
      { pane: lane.paneId, action: "inbox-dropped", detail: "1 message(s) for a closed target" },
    ]);
    expect(first.some((e) => e.action === "inbox-target-gone")).toBe(false);
    expect(d.store.queued(lane.sessionRef)).toEqual([]);

    w.clock += 60_000;
    const second = await dutyTick(d);
    expect(second.filter((e) => e.pane === lane.paneId || e.lane === "dead-pane")).toEqual([]);
  });

  test("a queued message for a live lane's missing pane is kept, not dropped", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "restarting", brief, { group: "w1" });
    w.panes.delete(lane.paneId);
    d.store.enqueue(lane.sessionRef, { at: w.clock, from: "cli", text: "wait for the pane" });

    // The lane is still open (the tick marks it lost only after the inbox phase), so its queue is preserved.
    expect(await dutyTick(d)).toContainEqual({ pane: lane.paneId, action: "inbox-target-gone" });
    expect(d.store.queued(lane.sessionRef)).toHaveLength(1);
  });

  test("a queued message for a registered role's missing pane is kept, not dropped", async () => {
    const { w, d } = setup();
    w.addPane("w1:p2", "idle");
    d.store.setRole("duty", href("w1:p2"));
    w.panes.delete("w1:p2");
    d.store.enqueue(href("w1:p2"), { at: w.clock, from: "cli", text: "wait for duty" });

    expect(await dutyTick(d)).toContainEqual({ pane: "w1:p2", action: "inbox-target-gone" });
    expect(d.store.queued(href("w1:p2"))).toHaveLength(1);
  });
});
