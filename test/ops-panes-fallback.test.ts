import { describe, expect, test } from "bun:test";
import type { SupervisorHealth } from "../src/supervisors.ts";
import { formatUnitPlacement } from "../src/unit-placement.ts";
import { PaneCloseFailed } from "../src/supervisors/panes.ts";
import { runUnitInPane } from "../src/supervisors/units.ts";
import { DUTY } from "./ops-panes-fixture.ts";
import { placement, RUNNING, STOPPED } from "./ops-panes-scripted.ts";

const STOP = new Error("stop the test loop");

describe("a placement that never matches falls back to headless", () => {
  test("a re-placement failure keeps the last pane's pid as a dead record", async () => {
    const { units } = placement(() => RUNNING, { windowMs: 0 });
    const record = new Map<string, { name: string; pid: number; pane?: string; alive: boolean }>();
    const lines: string[] = [];
    let calls = 0;
    const running = runUnitInPane({
      name: "duty",
      place: async () => {
        calls += 1;
        if (calls === 1) return units.place(DUTY);
        throw new Error("pane layer gone");
      },
      close: async () => {},
      headless: async () => {
        lines.push("headless");
        throw STOP;
      },
      onStart: (placed) => record.set("duty", { name: "duty", pid: placed.pid, pane: placed.pane.id, alive: true }),
      onExit: () => {
        record.delete("duty");
      },
      onUnplace: (placed) => {
        if (placed !== undefined) record.set("duty", { name: "duty", pid: placed.pid, alive: false });
      },
      alive: () => false,
      log: () => {},
      sleep: async () => {},
    });
    await running.catch(() => undefined);
    expect(record.get("duty")).toEqual({ name: "duty", pid: 400, alive: false });
    expect(lines).toEqual(["headless"]);
  });

  test("a throwing log never turns a close-held error into a headless fallback", async () => {
    let headless = false;
    await runUnitInPane({
      name: "duty",
      place: async () => {
        throw new PaneCloseFailed("pending line");
      },
      close: async () => {},
      headless: async () => {
        headless = true;
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {},
      onUnplace: () => {},
      alive: () => false,
      log: () => {
        throw new Error("log broken");
      },
      sleep: async () => {
        throw STOP;
      },
    }).catch(() => undefined);
    expect(headless).toBe(false);
  });

  test("a fallback reason with a control character is sanitized in the log", async () => {
    const logs: string[] = [];
    await runUnitInPane({
      name: "duty",
      place: async () => {
        throw new Error("bad\u0007news");
      },
      close: async () => {},
      headless: async () => {
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {},
      onUnplace: () => {},
      alive: () => false,
      log: (line) => logs.push(line),
      sleep: async () => {},
    }).catch(() => undefined);
    const fallback = logs.find((line) => line.includes("_pane_fallback"));
    expect(fallback).toBeDefined();
    expect(fallback).toContain("bad?news");
    expect(fallback).not.toContain("\u0007");
  });

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
