import { describe, expect, test } from "bun:test";
import type { SupervisorHealth } from "../src/supervisors.ts";
import { formatUnitPlacement } from "../src/unit-placement.ts";
import { runUnitInPane } from "../src/supervisors/units.ts";
import { DUTY } from "./ops-panes-fixture.ts";
import { placement, RUNNING, STOPPED } from "./ops-panes-scripted.ts";

const STOP = new Error("stop the test loop");

describe("a placement that never matches falls back to headless", () => {
  test("the typed lines are spent, every pane is closed, the record drops its pane, and the line names the unit", async () => {
    const { adapter, units } = placement(() => STOPPED, { windowMs: 0, attempts: 2 });
    const logs: string[] = [];
    const record = new Map<string, { name: string; pid: number; pane?: string; alive: boolean }>();
    record.set("duty", { name: "duty", pid: 111, pane: "old-pane", alive: false });
    const lines: string[] = [];
    const health = (): SupervisorHealth[] => [
      {
        name: "supervisor",
        pid: 1,
        alive: true,
        units: [...record.values()],
      },
    ];
    let headless = false;
    let exited = false;
    let unplaced = 0;
    const running = runUnitInPane({
      name: "duty",
      place: () => units.place(DUTY),
      close: (pane) => units.close(pane),
      headless: async () => {
        headless = true;
        lines.push(formatUnitPlacement(health(), ["duty"]));
        record.set("duty", { name: "duty", pid: 999, alive: true });
        lines.push(formatUnitPlacement(health(), ["duty"]));
        throw STOP;
      },
      onStart: (placed) => record.set("duty", { name: "duty", pid: placed.pid, pane: placed.pane.id, alive: true }),
      onExit: () => {
        exited = true;
        record.delete("duty");
      },
      onUnplace: () => {
        unplaced += 1;
        const cur = record.get("duty");
        if (cur !== undefined) record.set("duty", { name: cur.name, pid: cur.pid, alive: false });
      },
      alive: () => false,
      log: (line) => logs.push(line),
      sleep: async () => {},
    });
    expect(
      await running.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBe(STOP);
    expect(headless).toBe(true);
    expect(exited).toBe(false);
    expect(unplaced).toBe(1);
    expect(adapter.opened).toEqual(["p1", "p2"]);
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.closed).toEqual(["p1", "p2"]);
    expect(logs).toEqual(["SUPERVISED duty_pane_fallback reason=no duty process appeared after 2 attempts"]);
    // The record keeps the unit (dead, no pane) before the headless child starts, and reads as headless after it does.
    expect(lines[0]).toBe("UNITS panes=0/1 headless=none dead=duty missing=none");
    expect(lines[1]).toBe("UNITS panes=0/1 headless=duty dead=none missing=none");
  });
});

describe("a pane that will not close after a typed line", () => {
  test("the unit waits instead of starting headless, and the pane is never typed into twice", async () => {
    const started: string[] = [];
    const { adapter, units } = placement(
      (pane, poll) => {
        // The pending line would start if the pane were kept and polled long enough.
        if (poll > 20) {
          started.push(pane);
          return RUNNING;
        }
        return STOPPED;
      },
      { windowMs: 0, failClose: (pane) => pane === "p1" },
    );
    const logs: string[] = [];
    let headless = false;
    let sleeps = 0;
    const running = runUnitInPane({
      name: "duty",
      place: () => units.place(DUTY),
      close: (pane) => units.close(pane),
      headless: async () => {
        headless = true;
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {},
      alive: () => false,
      log: (line) => logs.push(line),
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) throw STOP;
      },
    });
    expect(
      await running.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBe(STOP);
    expect(headless).toBe(false);
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1"]);
    expect(started).toEqual([]);
    expect(logs.filter((line) => line.startsWith("SUPERVISED duty_pane_close_held"))).toHaveLength(1);
  });
});
