import { describe, expect, test } from "bun:test";
import { PaneCloseFailed, PaneUnknown } from "../src/supervisors/panes.ts";
import { DUTY, pref } from "./ops-panes-fixture.ts";
import { placement, RUNNING, STOPPED } from "./ops-panes-scripted.ts";

describe("a throwing logger never replaces a safety signal", () => {
  test("a close failure stays PaneCloseFailed while log and pending writes throw", async () => {
    const pending = {
      read: () => ["p1"],
      write: () => {
        throw new Error("disk full");
      },
    };
    const { units } = placement(() => STOPPED, {
      windowMs: 0,
      existing: [pref("p1")],
      pending,
      failClose: () => true,
      log: () => {
        throw new Error("log broken");
      },
    });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneCloseFailed);
  });
});

describe("doubt beside an adopted unit", () => {
  test("hc closes the doubtful leftover", async () => {
    const pending = { read: () => ["p1"], write: () => {} };
    const { adapter, units } = placement(
      (pane) => (pane === "p1" ? RUNNING : pane === "p2" ? { kind: "unknown", why: "no argv", pid: 954 } : STOPPED),
      { windowMs: 0, kind: "hc", existing: [pref("p1"), pref("p2")], pending },
    );
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.closed).toEqual(["p2"]);
  });

  test("herdr only logs the doubtful leftover", async () => {
    const { adapter, logs, units } = placement(
      (pane) => (pane === "p1" ? RUNNING : pane === "p2" ? { kind: "unknown", why: "no argv", pid: 955 } : STOPPED),
      { windowMs: 0, existing: [pref("p1"), pref("p2")] },
    );
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.closed).toEqual([]);
    expect(logs.some((line) => line.includes("duty_pane_doubt_left panes=1"))).toBe(true);
  });
});

describe("the first line keeps its whole window", () => {
  test("a unit that reports after the remaining budget is still adopted", async () => {
    const { units } = placement((_pane, poll) => (poll >= 4 ? RUNNING : STOPPED), {
      windowMs: 200,
      budgetMs: 100,
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
  });
});

describe("the doubt line is logged once", () => {
  test("a close that fails once logs the close only after it succeeds", async () => {
    let closes = 0;
    const { logs, units } = placement(
      (pane) => (pane === "p1" ? { kind: "unknown", why: "no argv", pid: 956 } : RUNNING),
      {
        windowMs: 0,
        kind: "hc",
        unknownWaitMs: 0,
        existing: [pref("p1")],
        closeAttempts: 1,
        failClose: () => {
          closes += 1;
          return closes === 1;
        },
      },
    );
    const first: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(PaneCloseFailed);
    expect(logs.filter((line) => line.includes("_pane_doubt_closed"))).toHaveLength(0);
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(logs.filter((line) => line.includes("_pane_doubt_closed"))).toHaveLength(1);
  });
});

describe("a readiness failure with a pending line", () => {
  test("is doubt, not a headless fallback", async () => {
    const pending = { read: () => ["p1"], write: () => {} };
    const { units } = placement(() => RUNNING, { windowMs: 0, existing: [pref("p1")], pending, readyFails: true });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
  });

  test("is a plain error when no line is pending", async () => {
    const { units } = placement(() => RUNNING, { windowMs: 0, readyFails: true });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).not.toBeInstanceOf(PaneUnknown);
    expect(String(failure)).toContain("runtime not ready");
  });
});

describe("a replaced doubtful pane", () => {
  test("starts its own wait instead of inheriting the old timer", async () => {
    const existing = [pref("p1")];
    const { advance, units } = placement(
      (pane) => (pane === "p1" || pane === "p2" ? { kind: "unknown", why: "no argv", pid: 957 } : RUNNING),
      { windowMs: 0, kind: "hc", unknownWaitMs: 5_000, existing },
    );
    const first: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(PaneUnknown);
    existing.length = 0;
    existing.push(pref("p2"));
    advance(3_000);
    const second: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(second).toBeInstanceOf(PaneUnknown);
    advance(2_500);
    const third: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(third).toBeInstanceOf(PaneUnknown);
  });
});

describe("an unreadable pending store", () => {
  test("is never replaced with a readable set while a unit is adopted", async () => {
    const writes: string[][] = [];
    const pending = {
      read: () => undefined,
      write: (ids: readonly string[]) => {
        writes.push([...ids]);
      },
    };
    const first = placement(() => RUNNING, { windowMs: 0, existing: [pref("p1")], pending });
    expect(await first.units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(writes).toEqual([]);
    const { adapter, units } = placement((pane) => (pane === "p1" ? RUNNING : STOPPED), {
      windowMs: 0,
      existing: [pref("p2")],
      pending,
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.closed).toEqual(["p2"]);
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1"]);
  });

  test("treats readiness as doubt when the store may hold a line", async () => {
    const pending = { read: () => undefined, write: () => {} };
    const { units } = placement(() => RUNNING, { windowMs: 0, readyFails: true, pending });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
  });
});

describe("a second running pane with the same title", () => {
  test("is closed so no duplicate of the unit survives", async () => {
    const { adapter, units } = placement(() => RUNNING, { windowMs: 0, existing: [pref("p1"), pref("p2")] });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.closed).toEqual(["p2"]);
  });
});

describe("a hinted hc adoption across a restart", () => {
  test("keeps the pane in the set and adopts it again without a close", async () => {
    const writes: string[][] = [];
    const pending = {
      read: () => ["p1"],
      write: (ids: readonly string[]) => {
        writes.push([...ids]);
      },
    };
    const { units } = placement(() => ({ kind: "unknown", why: "no argv", pid: 958 }), {
      windowMs: 0,
      kind: "hc",
      existing: [pref("p1")],
      pending,
    });
    expect(await units.place(DUTY)).toEqual({ pid: 958, pane: pref("p1") });
    expect(writes.at(-1)).toEqual(["p1"]);
    const restarted = placement(() => ({ kind: "unknown", why: "no argv", pid: 958 }), {
      windowMs: 0,
      kind: "hc",
      existing: [pref("p1")],
      pending: { read: () => writes.at(-1) ?? [], write: () => {} },
    });
    expect(await restarted.units.place(DUTY)).toEqual({ pid: 958, pane: pref("p1") });
    expect(restarted.adapter.closed).toEqual([]);
  });
});
