import { describe, expect, test } from "bun:test";
import { PaneCloseFailed, PaneUnknown } from "../src/supervisors/panes.ts";
import { runUnitInPane } from "../src/supervisors/units.ts";
import { DUTY, pref } from "./ops-panes-fixture.ts";
import { placement, RUNNING, STOPPED } from "./ops-panes-scripted.ts";

const STOP = new Error("stop the test loop");

describe("an hc foreground that cannot be named", () => {
  test("a pid the supervisor typed into is the unit, not doubt", async () => {
    const pending = { ids: ["p1"], read: () => ["p1"], write: () => {} };
    const { adapter, units } = placement(
      () => ({ kind: "unknown", why: "pane foreground reports no command line", pid: 900 }),
      { windowMs: 0, kind: "hc", existing: [pref("p1")], pending },
    );
    expect(await units.place(DUTY)).toEqual({ pid: 900, pane: pref("p1") });
    expect(adapter.starts).toHaveLength(0);
  });

  test("an untyped doubtful pane is closed after a bounded wait and replaced", async () => {
    const { adapter, logs, units } = placement(
      (pane) => (pane === "p2" ? RUNNING : { kind: "unknown", why: "no argv", pid: 901 }),
      {
        windowMs: 0,
        kind: "hc",
        unknownWaitMs: 0,
        existing: [pref("p1")],
      },
    );
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(adapter.closed).toEqual(["p1"]);
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p2"]);
    expect(logs.some((line) => line.includes("duty_pane_doubt_closed panes=1"))).toBe(true);
  });

  test("herdr doubt is never closed, it waits", async () => {
    const { adapter, units } = placement(() => ({ kind: "unknown", why: "no tree", pid: 902 }), {
      windowMs: 0,
      existing: [pref("p1")],
    });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(adapter.closed).toEqual([]);
    expect(adapter.starts).toEqual([]);
  });
});

describe("the placement budget across a slow open", () => {
  test("a pane opened after the budget is closed without a line being typed", async () => {
    const { adapter, units } = placement(() => STOPPED, { windowMs: 0, budgetMs: 100, openDelayMs: 200 });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(failure)).toContain("the placement budget ran out before a line was typed");
    expect(adapter.starts).toEqual([]);
    expect(adapter.closed).toEqual(["p1"]);
  });
});

describe("the unit loop's once-per-situation logs", () => {
  test("unknown and close-held each announce once, without suppressing one another", async () => {
    const logs: string[] = [];
    let calls = 0;
    const running = runUnitInPane({
      name: "duty",
      place: async () => {
        calls += 1;
        if (calls === 1) throw new PaneUnknown("cannot read");
        if (calls === 2) throw new PaneCloseFailed("could not close p1");
        throw new PaneUnknown("still unreadable");
      },
      close: async () => {},
      headless: async () => {
        throw STOP;
      },
      onStart: () => {},
      onExit: () => {},
      alive: () => false,
      log: (line) => logs.push(line),
      sleep: async () => {
        if (calls >= 3) throw STOP;
      },
    });
    expect(
      await running.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBe(STOP);
    expect(logs).toEqual([
      "SUPERVISED duty_pane_unknown reason=cannot read",
      "SUPERVISED duty_pane_close_held reason=could not close p1",
    ]);
  });
});
