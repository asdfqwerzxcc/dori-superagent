import { describe, expect, test } from "bun:test";
import type { SessionRef } from "../src/runtime/types.ts";
import { PaneUnknown, type PaneProbe } from "../src/supervisors/panes.ts";
import { DUTY, pref } from "./ops-panes-fixture.ts";
import { placement, RUNNING, startsOn, STOPPED } from "./ops-panes-scripted.ts";

describe("one typed line per pane", () => {
  test("a unit that appears late in its window is placed without another pane", async () => {
    const { adapter, sleeps, units } = placement((_pane, poll) => (poll >= 3 ? RUNNING : STOPPED), { windowMs: 100 });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.opened).toEqual(["p1"]);
    expect(adapter.starts).toHaveLength(1);
    expect(sleeps).toEqual([50, 50]);
  });

  test("a swallowed line closes its pane and the next line goes into a fresh pane", async () => {
    const { adapter, logs, sleeps, units } = placement((pane) => (pane === "p2" ? RUNNING : STOPPED), {
      windowMs: 100,
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(adapter.opened).toEqual(["p1", "p2"]);
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1", "p2"]);
    expect(adapter.closed).toEqual(["p1"]);
    expect(sleeps).toEqual([50, 50, 1_000]);
    expect(logs).toEqual(["SUPERVISED duty_pane_start_failed reason=no duty process appeared in p1 after 1 attempt"]);
  });

  test("a line that appears only after its window is killed with its pane, never retyped into that shell", async () => {
    const started: string[] = [];
    const { adapter, units } = placement(
      (pane, poll) => {
        if (pane === "p1" && poll > 5) {
          started.push(pane);
          return RUNNING;
        }
        if (pane === "p2") started.push(pane);
        return pane === "p1" ? STOPPED : RUNNING;
      },
      { windowMs: 100 },
    );
    const placed = await units.place(DUTY);
    expect(placed.pane).toEqual(pref("p2"));
    expect(startsOn(adapter, "p1")).toBe(1);
    expect(adapter.closed).toContain("p1");
    // Only the fresh pane's process ever starts; p1's late line dies with its closed pane.
    expect(started).toEqual(["p2"]);
  });

  test("a unit whose process is seen by the final probe before the close is adopted", async () => {
    // Polls 1-3 fill the 100 ms window; the read before the close is poll 4 and sees the unit.
    const { adapter, units } = placement((_pane, poll) => (poll >= 4 ? RUNNING : STOPPED), { windowMs: 100 });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.closed).toEqual([]);
  });

  test("a slow start inside the first window is adopted, never closed and retried", async () => {
    const { adapter, units } = placement((_pane, poll) => (poll >= 40 ? RUNNING : STOPPED), { windowMs: 3_000 });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.closed).toEqual([]);
  });

  test("the backoff doubles and stops at its cap across fresh panes", async () => {
    const { adapter, sleeps, units } = placement(() => STOPPED, { windowMs: 0, attempts: 5 });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(failure)).toContain("after 5 attempts");
    expect(adapter.opened).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(adapter.starts.map((s) => s.at)).toEqual([0, 1_000, 3_000, 7_000, 11_000]);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 4_000]);
    expect(adapter.closed).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  test("the placement budget caps the lines, and the backoff inside it is clamped", async () => {
    const budget = 1_500;
    const { adapter, sleeps, units } = placement(() => STOPPED, { windowMs: 1_000, attempts: 10, budgetMs: budget });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(failure)).toContain("after 1 attempt");
    expect(adapter.starts.map((s) => s.at)).toEqual([0]);
    expect(adapter.starts.every((s) => s.at <= budget)).toBe(true);
    expect(sleeps.at(-1)).toBe(500);
  });

  test("the budget is shared by the reused pane and the fresh ones", async () => {
    const { adapter, sleeps, units } = placement(() => STOPPED, {
      windowMs: 1_000,
      attempts: 10,
      budgetMs: 1_500,
      existing: [pref("p1")],
    });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(failure)).toContain("after 1 attempt");
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1"]);
    expect(adapter.opened).toEqual([]);
    expect(adapter.closed).toEqual(["p1"]);
    expect(sleeps.at(-1)).toBe(500);
  });

  test("a later backoff is clamped to the budget, and no line is typed after it", async () => {
    const budget = 2_500;
    const { adapter, sleeps, units } = placement(() => STOPPED, { windowMs: 0, attempts: 5, budgetMs: budget });
    await units.place(DUTY).catch(() => undefined);
    expect(adapter.starts.map((s) => s.at)).toEqual([0, 1_000]);
    expect(adapter.starts.every((s) => s.at <= budget)).toBe(true);
    expect(sleeps).toEqual([1_000, 1_500]);
  });

  test("an unreadable probe ends the retries and leaves the pane open", async () => {
    const { adapter, units } = placement((_pane, poll) => (poll >= 2 ? { kind: "unknown", why: "gone" } : STOPPED), {
      windowMs: 50,
    });
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(adapter.opened).toEqual(["p1"]);
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.closed).toEqual([]);
  });

  test("a stopped existing pane is typed once, closed, and replaced by a fresh pane", async () => {
    const { adapter, units } = placement((pane, poll) => (pane === "p1" && poll >= 2 ? RUNNING : STOPPED), {
      windowMs: 0,
      existing: [pref("p1")],
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1"]);
    expect(adapter.opened).toEqual([]);

    const second = placement((pane) => (pane === "p2" ? RUNNING : STOPPED), { windowMs: 0, existing: [pref("p1")] });
    expect(await second.units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(second.adapter.starts.map((s) => s.pane)).toEqual(["p1", "p2"]);
    expect(second.adapter.closed).toEqual(["p1"]);
    expect(second.logs).toEqual([
      "SUPERVISED duty_pane_start_failed reason=no duty process appeared in p1 after 1 attempt",
    ]);
  });

  test("a probe that throws after the line was typed is doubt, and the pane is left open", async () => {
    const { adapter, units } = placement(
      (_pane, poll) => {
        if (poll === 1) return STOPPED;
        throw new Error("probe exploded");
      },
      { windowMs: 0 },
    );
    const failure: unknown = await units.place(DUTY).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.closed).toEqual([]);
  });

  test("a successfully placed pane is reused after its unit exits", async () => {
    const probes: PaneProbe[] = [RUNNING, STOPPED, RUNNING];
    const { adapter, units } = placement(() => probes.shift() ?? RUNNING, { windowMs: 0 });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p1") });
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1", "p1"]);
    expect(adapter.closed).toEqual([]);
  });

  test("with two stopped panes, a typed second pane is closed before any typing", async () => {
    const existing: SessionRef[] = [];
    let closeFails = true;
    const { adapter, units } = placement((pane, poll) => (pane === "p2" && poll >= 2 ? RUNNING : STOPPED), {
      windowMs: 0,
      existing,
      failClose: (pane) => pane === "p1" && closeFails,
    });
    await units.place(DUTY).catch(() => undefined);
    existing.push(pref("p2"));
    closeFails = false;
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1", "p2"]);
    expect(adapter.closed).toEqual(["p1"]);
  });

  test("a restart with a persisted pending pane never types into it", async () => {
    const store = {
      ids: [] as string[],
      read(): readonly string[] {
        return this.ids;
      },
      write(ids: readonly string[]): void {
        this.ids = [...ids];
      },
    };
    const first = placement(() => STOPPED, { windowMs: 0, failClose: () => true, pending: store });
    await first.units.place(DUTY).catch(() => undefined);
    expect(store.ids).toEqual(["p1"]);

    const second = placement((pane) => (pane === "p2" ? RUNNING : STOPPED), {
      windowMs: 0,
      existing: [pref("p1")],
      pending: store,
    });
    expect(await second.units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(second.adapter.starts.map((s) => s.pane)).toEqual(["p2"]);
    expect(second.adapter.closed).toEqual(["p1"]);
    expect(store.ids).toEqual([]);
  });
});
