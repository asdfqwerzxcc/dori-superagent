import { describe, expect, test } from "bun:test";
import type { SessionRef } from "../src/runtime/types.ts";
import { PaneUnits, type PaneAdapter, type PaneUnit, type PlacedUnit } from "../src/supervisors/panes.ts";
import { paneCommand, runUnitInPane } from "../src/supervisors/units.ts";

const ref = (id: string): SessionRef => ({ runtime: "herdr", id, group: "w1", container: `t-${id}` });

class FakeAdapter implements PaneAdapter {
  readonly kind = "herdr" as const;
  readonly opened: string[] = [];
  readonly started: { ref: SessionRef; command: string }[] = [];
  readonly closed: SessionRef[] = [];
  readonly panes: { name: string; ref: SessionRef }[] = [];
  readonly live = new Map<string, number>();
  readonly failStart = new Set<string>();
  private nextPid = 100;
  private nextPane = 1;

  async ready(): Promise<void> {}

  async find(name: string): Promise<SessionRef | undefined> {
    return this.panes.find((p) => p.name === name)?.ref;
  }

  async open(name: string): Promise<SessionRef> {
    const pane = ref(`p${this.nextPane++}`);
    this.panes.push({ name, ref: pane });
    this.opened.push(name);
    return pane;
  }

  async start(pane: SessionRef, command: string): Promise<void> {
    this.started.push({ ref: pane, command });
    if (this.failStart.has(pane.id)) throw new Error("pane refused the command");
    this.live.set(pane.id, this.nextPid++);
  }

  async pid(pane: SessionRef): Promise<number | undefined> {
    return this.live.get(pane.id);
  }

  async close(pane: SessionRef): Promise<void> {
    this.closed.push(pane);
    const at = this.panes.findIndex((p) => p.ref.id === pane.id);
    if (at >= 0) this.panes.splice(at, 1);
    this.live.delete(pane.id);
  }
}

const unit: PaneUnit = { name: "duty", command: "'bun' 'cli.ts' 'duty'", marker: ["cli.ts", "duty"] };
const units = (adapter: PaneAdapter, pidTimeoutMs = 0): PaneUnits =>
  new PaneUnits({ adapter, log: () => {}, sleep: async () => {}, pidTimeoutMs });

describe("pane placement", () => {
  test("a unit is placed in exactly one titled pane and its pid is recorded", async () => {
    const adapter = new FakeAdapter();
    const placed = await units(adapter).place(unit);
    expect(adapter.opened).toEqual(["duty"]);
    expect(placed).toEqual({ pid: 100, pane: ref("p1") });
    expect(adapter.started).toHaveLength(1);
  });

  test("a live pane for the same unit is adopted, never duplicated", async () => {
    const adapter = new FakeAdapter();
    const first = await units(adapter).place(unit);
    const second = await units(adapter).place(unit);
    expect(adapter.opened).toHaveLength(1);
    expect(second).toEqual(first);
    expect(adapter.started).toHaveLength(1);
  });

  test("a pane whose unit died is reused for the restart", async () => {
    const adapter = new FakeAdapter();
    const first = await units(adapter).place(unit);
    adapter.live.delete(first.pane.id);
    const second = await units(adapter).place(unit);
    expect(adapter.opened).toHaveLength(1);
    expect(second.pane).toEqual(first.pane);
    expect(second.pid).not.toBe(first.pid);
    expect(adapter.started).toHaveLength(2);
  });

  test("a pane that will not start the unit is closed and replaced", async () => {
    const adapter = new FakeAdapter();
    const first = await units(adapter).place(unit);
    adapter.live.delete(first.pane.id);
    adapter.failStart.add(first.pane.id);
    const second = await units(adapter).place(unit);
    expect(adapter.opened).toEqual(["duty", "duty"]);
    expect(adapter.closed.map((pane) => pane.id)).toContain(first.pane.id);
    expect(second.pane.id).not.toBe(first.pane.id);
  });
});

describe("the pane unit loop", () => {
  const STOP = new Error("stop the test loop");

  test("a dead unit is placed again in the same pane after the restart delay", async () => {
    const adapter = new FakeAdapter();
    const starts: PlacedUnit[] = [];
    const sleeps: number[] = [];
    let alive = true;
    const running = runUnitInPane({
      name: "duty",
      place: () => units(adapter).place(unit),
      close: (pane) => units(adapter).close(pane),
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
        adapter.live.delete(starts[0]!.pane.id);
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
      place: () => units(adapter).place({ ...unit, name: "update-check" }),
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
