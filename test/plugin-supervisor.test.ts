import { describe, expect, test } from "bun:test";
import { runPluginUnit, type Spawned } from "../src/supervisors/plugins.ts";

class FakeChild implements Spawned {
  private listeners: ((code: number | null) => void)[] = [];
  constructor(readonly pid: number) {}
  on(_event: "exit", listener: (code: number | null) => void): this {
    this.listeners.push(listener);
    return this;
  }
  exit(code: number | null = 0): void {
    const listeners = this.listeners;
    this.listeners = [];
    for (const listener of listeners) listener(code);
  }
}

const STOP = new Error("stop the test loop");

describe("supervisor plugin units", () => {
  test("a plugin child is started again 5 s after it exits", async () => {
    const children: FakeChild[] = [];
    const starts: number[] = [];
    const stops: number[] = [];
    const delays: number[] = [];
    const failure: unknown = await runPluginUnit({
      name: "flappy",
      spawnChild: () => {
        const child = new FakeChild(100 + children.length);
        children.push(child);
        queueMicrotask(() => child.exit(1));
        return child;
      },
      stopChild: async () => {},
      isEnabled: () => true,
      onStart: (pid) => starts.push(pid),
      onStop: () => stops.push(1),
      log: () => {},
      sleep: async (ms) => {
        delays.push(ms);
        if (delays.length >= 2) throw STOP;
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBe(STOP);
    expect(starts).toEqual([100, 101]);
    expect(stops).toHaveLength(2);
    expect(delays).toEqual([5_000, 5_000]);
  });

  test("one plugin's crash and restarts never touch another plugin's child", async () => {
    const healthy = new FakeChild(200);
    const goodStarts: number[] = [];
    const badStarts: number[] = [];
    let bothFailed: () => void = () => {};
    const failedTwice = new Promise<void>((resolve) => {
      bothFailed = resolve;
    });
    const good = runPluginUnit({
      name: "good",
      spawnChild: () => healthy,
      stopChild: async () => {},
      isEnabled: () => true,
      onStart: (pid) => goodStarts.push(pid),
      onStop: () => {},
      log: () => {},
      sleep: async () => {
        throw STOP;
      },
      pollMs: 1,
    });
    const bad = runPluginUnit({
      name: "bad",
      spawnChild: () => {
        const child = new FakeChild(300 + badStarts.length);
        badStarts.push(child.pid);
        if (badStarts.length === 2) bothFailed();
        queueMicrotask(() => child.exit(1));
        return child;
      },
      stopChild: async () => {},
      isEnabled: () => true,
      onStart: () => {},
      onStop: () => {},
      log: () => {},
      sleep: async () => {
        if (badStarts.length >= 2) throw STOP;
      },
      pollMs: 1,
    });
    await failedTwice;
    expect(goodStarts).toEqual([200]);
    expect(badStarts).toEqual([300, 301]);
    healthy.exit(0);
    const settled = await Promise.allSettled([good, bad]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
  });

  test("a live standby child is not restarted for a missing tick", async () => {
    const child = new FakeChild(500);
    let spawns = 0;
    let stops = 0;
    let startedResolve: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const run = runPluginUnit({
      name: "ensure-up",
      spawnChild: () => {
        spawns += 1;
        return child;
      },
      stopChild: async () => {
        stops += 1;
      },
      isEnabled: () => true,
      onStart: () => startedResolve(),
      onStop: () => {},
      log: () => {},
      sleep: async () => {
        throw STOP;
      },
      pollMs: 5,
      restartMs: 5,
    });
    await started;
    // A waiting standby has no tick, but the supervisor restarts only after its child exits.
    expect(spawns).toBe(1);
    expect(stops).toBe(0);
    child.exit(0);
    const failure: unknown = await run.then(
      () => undefined,
      (e) => e,
    );
    expect(failure).toBe(STOP);
  });

  test("disabling a plugin stops its running child and calls onStop once", async () => {
    let enabled = true;
    const child = new FakeChild(400);
    const starts: number[] = [];
    let stops = 0;
    let stoppedWith: number | undefined;
    let startedResolve: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let resolvedStop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      resolvedStop = resolve;
    });
    const run = runPluginUnit({
      name: "switched",
      spawnChild: () => child,
      stopChild: async (pid) => {
        stoppedWith = pid;
        resolvedStop();
        child.exit(0);
      },
      isEnabled: () => enabled,
      onStart: (pid) => {
        starts.push(pid);
        startedResolve();
      },
      onStop: () => {
        stops += 1;
      },
      log: () => {},
      sleep: async () => {
        throw STOP;
      },
      pollMs: 1,
    });
    await started;
    expect(starts).toEqual([400]);
    enabled = false;
    await stopped;
    await run.then(
      () => undefined,
      () => undefined,
    );
    expect(stoppedWith).toBe(400);
    expect(stops).toBe(1);
  });
});
