import { describe, expect, test } from "bun:test";
import { PaneCloseFailed, PaneUnknown } from "../src/supervisors/panes.ts";
import { paneCommand } from "../src/supervisors/units.ts";
import { DUTY, FakeAdapter, pref, unitsOf } from "./ops-panes-fixture.ts";

describe("pane placement", () => {
  test("a unit is placed in exactly one titled pane and its pid is recorded", async () => {
    const adapter = new FakeAdapter();
    const placed = await unitsOf(adapter).place(DUTY);
    expect(adapter.opened).toEqual(["duty"]);
    expect(placed).toEqual({ pid: 100, pane: pref("p1") });
    expect(adapter.started).toHaveLength(1);
  });

  test("a live pane for the same unit is adopted, never duplicated", async () => {
    const adapter = new FakeAdapter();
    const first = await unitsOf(adapter).place(DUTY);
    const second = await unitsOf(adapter).place(DUTY);
    expect(adapter.opened).toHaveLength(1);
    expect(second).toEqual(first);
    expect(adapter.started).toHaveLength(1);
  });

  test("a pane whose unit died is reused for the restart", async () => {
    const adapter = new FakeAdapter();
    const first = await unitsOf(adapter).place(DUTY);
    adapter.probes.set(first.pane.id, { kind: "stopped" });
    const second = await unitsOf(adapter).place(DUTY);
    expect(adapter.opened).toHaveLength(1);
    expect(second.pane).toEqual(first.pane);
    expect(second.pid).not.toBe(first.pid);
    expect(adapter.started).toHaveLength(2);
  });

  test("a pane that will not start the unit is closed and replaced", async () => {
    const adapter = new FakeAdapter();
    const first = await unitsOf(adapter).place(DUTY);
    adapter.probes.set(first.pane.id, { kind: "stopped" });
    adapter.failStart.add(first.pane.id);
    const second = await unitsOf(adapter).place(DUTY);
    expect(adapter.opened).toEqual(["duty", "duty"]);
    expect(adapter.closed.map((pane) => pane.id)).toContain(first.pane.id);
    expect(second.pane.id).not.toBe(first.pane.id);
  });

  test("a pane that cannot be closed after a failed start is not duplicated", async () => {
    const adapter = new FakeAdapter();
    const first = await unitsOf(adapter).place(DUTY);
    adapter.probes.set(first.pane.id, { kind: "stopped" });
    adapter.failStart.add(first.pane.id);
    adapter.failClose.add(first.pane.id);
    const logs: string[] = [];
    const failure: unknown = await unitsOf(adapter, (line) => logs.push(line))
      .place(DUTY)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(PaneCloseFailed);
    expect(adapter.closeAttempts.get(first.pane.id)).toBe(2);
    expect(adapter.opened).toEqual(["duty"]);
    expect(adapter.panesList).toHaveLength(1);
    expect(logs.some((line) => line.includes("duty_pane_close_failed"))).toBe(true);
  });

  test("two same-titled panes: the unit is adopted only in the pane that owns its process", async () => {
    const adapter = new FakeAdapter();
    adapter.panesList.push({ name: "duty", ref: pref("p1") }, { name: "duty", ref: pref("p2") });
    adapter.probes.set("p1", { kind: "stopped" });
    adapter.probes.set("p2", { kind: "running", pid: 3132 });
    const placed = await unitsOf(adapter).place(DUTY);
    expect(placed).toEqual({ pid: 3132, pane: pref("p2") });
    expect(adapter.started).toEqual([]);
    expect(adapter.opened).toEqual([]);
  });

  test("an unreadable process list never reuses or opens a second pane", async () => {
    const adapter = new FakeAdapter();
    adapter.panesList.push({ name: "duty", ref: pref("p1") });
    adapter.probes.set("p1", { kind: "unknown", why: "process list unavailable" });
    const failure: unknown = await unitsOf(adapter)
      .place(DUTY)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(adapter.started).toEqual([]);
    expect(adapter.opened).toEqual([]);
    expect(adapter.panesList).toHaveLength(1);
  });
});

describe("pane command lines", () => {
  test("every word is quoted for its shell", () => {
    expect(paneCommand("C:\\bun\\bun.exe", ["C:\\a b\\cli.ts", "duty"], "powershell")).toBe(
      "& 'C:\\bun\\bun.exe' 'C:\\a b\\cli.ts' 'duty'",
    );
    expect(paneCommand("/usr/bin/bun", ["/a b/cli.ts", "duty"], "sh")).toBe("'/usr/bin/bun' '/a b/cli.ts' 'duty'");
    expect(paneCommand("/b", ["it's"], "sh")).toBe("'/b' 'it'\\''s'");
    expect(paneCommand("b", ["it's"], "powershell")).toBe("& 'b' 'it''s'");
  });
});
