import { describe, expect, test } from "bun:test";
import { runUnitInPane } from "../src/supervisors/units.ts";
import { DUTY, pref } from "./ops-panes-fixture.ts";
import { placement, RUNNING, STOPPED } from "./ops-panes-scripted.ts";

const STOP = new Error("stop the test loop");

describe("a pane that refuses the command line", () => {
  test("a refused reused start is closed, and the fresh pane takes the unit", async () => {
    const { adapter, logs, units } = placement((pane) => (pane === "p2" ? RUNNING : STOPPED), {
      windowMs: 0,
      existing: [pref("p1")],
      failStart: (pane) => pane === "p1",
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1", "p2"]);
    expect(adapter.closed).toEqual(["p1"]);
    expect(logs[0]).toBe("SUPERVISED duty_pane_start_failed reason=pane refused the command");
  });

  test("a refused fresh start is retried on the next pane after the backoff", async () => {
    const { adapter, logs, sleeps, units } = placement((pane) => (pane === "p2" ? RUNNING : STOPPED), {
      windowMs: 0,
      failStart: (pane) => pane === "p1",
    });
    expect(await units.place(DUTY)).toEqual({ pid: 400, pane: pref("p2") });
    expect(adapter.starts.map((s) => s.pane)).toEqual(["p1", "p2"]);
    expect(adapter.closed).toEqual(["p1"]);
    expect(sleeps).toEqual([1_000]);
    expect(logs).toEqual(["SUPERVISED duty_pane_start_failed reason=pane refused the command"]);
  });

  test("every start refused names the refusal and falls back headless", async () => {
    const { adapter, units } = placement(() => STOPPED, { windowMs: 0, attempts: 2, failStart: () => true });
    const logs: string[] = [];
    let headless = false;
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
      sleep: async () => {},
    });
    expect(
      await running.then(
        () => undefined,
        (e: unknown) => e,
      ),
    ).toBe(STOP);
    expect(headless).toBe(true);
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.closed).toEqual(["p1", "p2"]);
    expect(logs).toEqual([
      "SUPERVISED duty_pane_fallback reason=no duty process appeared: every start was refused (pane refused the command)",
    ]);
  });
});
