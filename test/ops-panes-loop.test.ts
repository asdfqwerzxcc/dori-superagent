import { describe, expect, test } from "bun:test";
import { PaneUnknown, type PlacedUnit } from "../src/supervisors/panes.ts";
import { runUnitInPane } from "../src/supervisors/units.ts";
import { DUTY, FakeAdapter, pref, unitsOf } from "./ops-panes-fixture.ts";

const STOP = new Error("stop the test loop");

describe("the pane unit loop", () => {
  test("a dead unit is placed again in the same pane after the restart delay", async () => {
    const adapter = new FakeAdapter();
    const starts: PlacedUnit[] = [];
    const sleeps: number[] = [];
    let alive = true;
    const running = runUnitInPane({
      name: "duty",
      place: () => unitsOf(adapter).place(DUTY),
      close: (pane) => unitsOf(adapter).close(pane),
      headless: async () => {
        throw STOP;
      },
      onStart: (placed) => {
        starts.push(placed);
        if (starts.length === 2) throw STOP;
      },
      onExit: () => {},
      alive: () => alive,
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        alive = false;
        adapter.probes.set(starts[0]!.pane.id, { kind: "stopped" });
      },
    });
    const failure: unknown = await running.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBe(STOP);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.pane).toEqual(starts[0]!.pane);
    expect(starts[1]!.pid).not.toBe(starts[0]!.pid);
    expect(sleeps).toEqual([1_000, 5_000]);
  });

  test("unknown liveness retries placement and never falls back to a headless copy", async () => {
    let attempts = 0;
    const logs: string[] = [];
    const running = runUnitInPane({
      name: "duty",
      place: async () => {
        attempts += 1;
        if (attempts === 1) throw new PaneUnknown("process list unavailable");
        return { pid: 7, pane: pref("p1") };
      },
      close: async () => {},
      headless: async () => {
        throw new Error("must not fall back");
      },
      onStart: () => {
        throw STOP;
      },
      onExit: () => {},
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
    expect(attempts).toBe(2);
    expect(logs).toEqual(["SUPERVISED duty_pane_unknown reason=process list unavailable"]);
  });

  test("a placement failure falls back to the headless loop with one warning", async () => {
    const logs: string[] = [];
    const running = runUnitInPane({
      name: "duty",
      place: async () => {
        throw new Error("herdr is gone");
      },
      close: async () => {},
      headless: async () => {
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {},
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
    expect(logs).toEqual(["SUPERVISED duty_pane_fallback reason=herdr is gone"]);
  });

  test("a disabled plugin's pane is closed and the loop waits for it", async () => {
    const adapter = new FakeAdapter();
    let enabled = true;
    let closed = 0;
    let exits = 0;
    const sleeps: number[] = [];
    const running = runUnitInPane({
      name: "update-check",
      place: () => unitsOf(adapter).place({ ...DUTY, name: "update-check" }),
      close: async (pane) => {
        closed += 1;
        await adapter.close(pane);
      },
      headless: async () => {
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {
        exits += 1;
      },
      alive: () => true,
      enabled: () => enabled,
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) enabled = false;
        if (sleeps.length === 2) throw STOP;
      },
    });
    expect(
      await running.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBe(STOP);
    expect({ closed, exits }).toEqual({ closed: 1, exits: 1 });
    expect(adapter.opened).toEqual(["update-check"]);
  });
});
