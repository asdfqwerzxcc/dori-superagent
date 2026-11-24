import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { status } from "../src/cli-up.ts";
import { pluginCtx } from "../src/plugins/plugin.ts";
import { PLUGINS, pluginByName } from "../src/plugins/registry.ts";
import { acquirePluginLock, runPluginChild, runTicks } from "../src/plugins/run.ts";
import {
  enabledPluginNames,
  isPluginEnabled,
  pluginHealth,
  pluginLines,
  pluginListLines,
  readPluginsConfig,
  setPluginEnabled,
  writePluginRecord,
  writePluginTick,
  writePluginsConfig,
} from "../src/plugins/state.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";
import { superviseHome } from "../src/supervisor-run.ts";

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-plugin-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const alive = (): boolean => true;
const NAMES = ["ensure-up", "update-check", "gateway-catchup", "silence-check"];

describe("plugin registry", () => {
  test("the registry is the explicit list, resolved by name in registry order", () => {
    expect(PLUGINS.map((p) => p.name)).toEqual(NAMES);
    expect(pluginByName("update-check")?.intervalMs).toBe(300_000);
    expect(pluginByName("ensure-up")?.intervalMs).toBe(20_000);
    expect(pluginByName("gateway-catchup")?.intervalMs).toBe(60_000);
    expect(pluginByName("silence-check")?.intervalMs).toBe(60_000);
    expect(pluginByName("nope")).toBeUndefined();
  });

  test("state/plugins.json disables exactly one plugin and leaves the rest enabled", () => {
    const home = homeWithState();
    expect(enabledPluginNames(home)).toEqual(NAMES);
    writePluginsConfig(home, setPluginEnabled(home, "gateway-catchup", false));
    expect(readPluginsConfig(home)).toEqual({ disabled: ["gateway-catchup"] });
    expect(isPluginEnabled(home, "gateway-catchup")).toBe(false);
    expect(enabledPluginNames(home)).toEqual(["ensure-up", "update-check", "silence-check"]);
    writePluginsConfig(home, setPluginEnabled(home, "gateway-catchup", true));
    expect(enabledPluginNames(home)).toEqual(NAMES);
    expect(isPluginEnabled(home, "unregistered")).toBe(false);
  });
});

describe("a plugin that throws", () => {
  test("logs a warning on that tick and the next tick still runs", async () => {
    const home = homeWithState();
    const ctx = pluginCtx(home, "boom");
    const logs: string[] = [];
    let ticks = 0;
    const ran = await runTicks(
      {
        name: "boom",
        intervalMs: 1,
        status: () => "",
        run: async () => {
          ticks += 1;
          throw new Error("kaboom");
        },
      },
      { ...ctx, log: (line) => logs.push(line) },
      { ticks: 2, sleep: async () => {} },
    );
    expect([ran, ticks]).toEqual([2, 2]);
    expect(logs.filter((line) => line.startsWith("PLUGIN_WARN boom"))).toHaveLength(2);
  });

  test("cannot reach another plugin's ticks when both run side by side", async () => {
    const home = homeWithState();
    const ctx = pluginCtx(home, "pair");
    const good: number[] = [];
    const sleep = async () => {};
    const [badRan, goodRan] = await Promise.all([
      runTicks(
        {
          name: "bad",
          intervalMs: 1,
          status: () => "",
          run: async () => {
            throw new Error("x");
          },
        },
        { ...ctx, log: () => {} },
        { ticks: 3, sleep },
      ),
      runTicks(
        {
          name: "good",
          intervalMs: 1,
          status: () => "",
          run: async () => {
            good.push(1);
          },
        },
        { ...ctx, log: () => {} },
        { ticks: 3, sleep },
      ),
    ]);
    expect([badRan, goodRan, good.length]).toEqual([3, 3, 3]);
  });

  test("an unknown plugin name never becomes a child", async () => {
    expect(await runPluginChild("nope", { home: homeWithState(), ticks: 1 })).toBe(64);
  });
});

describe("plugin records, locks and lines", () => {
  test("a live record plus a fresh tick is up, a dead pid or a stale beat is DOWN", () => {
    const home = homeWithState();
    const now = Date.now();
    writePluginRecord(home, { name: "ensure-up", pid: process.pid, startedAt: now, at: now });
    writePluginTick(home, "ensure-up", now);
    expect(pluginHealth(home, pluginByName("ensure-up")!, now + 1_000, alive)).toMatchObject({
      name: "ensure-up",
      enabled: true,
      pid: process.pid,
      alive: true,
      heartbeatAgeMs: 1_000,
    });
    expect(pluginHealth(home, pluginByName("ensure-up")!, now + 300_000, alive).alive).toBe(false);

    writePluginRecord(home, { name: "gateway-catchup", pid: 999_999, startedAt: now, at: now });
    const dead = pluginHealth(home, pluginByName("gateway-catchup")!, now, () => false);
    expect(dead).toMatchObject({ pid: 999_999, alive: false });
  });

  test("status lines are one per enabled plugin; disabled leaves none and the list still shows it", () => {
    const home = homeWithState();
    const now = Date.now();
    for (const name of NAMES) writePluginTick(home, name, now);
    expect(pluginLines(home, now + 1_000, alive)).toEqual([
      `PLUGIN ensure-up up pid=${process.pid} hb=1s`,
      `PLUGIN update-check up pid=${process.pid} hb=1s (next 04:00)`,
      `PLUGIN gateway-catchup up pid=${process.pid} hb=1s`,
      `PLUGIN silence-check up pid=${process.pid} hb=1s`,
    ]);

    writePluginsConfig(home, setPluginEnabled(home, "update-check", false));
    expect(pluginLines(home, now + 1_000, alive)).toHaveLength(3);
    expect(pluginListLines(home, now + 1_000, alive)).toContain("PLUGIN update-check disabled");

    writeFileSync(join(home, "state", "ensure-up.off"), "");
    expect(pluginLines(home, now + 1_000, alive)[0]).toBe(`PLUGIN ensure-up up pid=${process.pid} hb=1s (off)`);
  });

  test("the runner lock is held while its owner lives and taken over once it does not", () => {
    const home = homeWithState();
    const path = pluginCtx(home, "x").lockPath;
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: 0 }));
    expect(acquirePluginLock(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ pid: 999_999, at: 0 }));
    expect(acquirePluginLock(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(String(process.pid));
    expect(existsSync(path)).toBe(true);
  });
});

describe("dori plugin and dori status", () => {
  test("disable removes exactly that line from status and enable brings it back", async () => {
    const w = new World();
    const d = w.deps();
    const home = d.store.root;
    for (const name of NAMES) writePluginTick(home, name);
    const pluginLinesOf = async (): Promise<string[]> =>
      (
        await captureIo(async () => {
          await status(d);
          return 0;
        })
      ).out
        .split("\n")
        .filter((line) => line.startsWith("PLUGIN "));

    expect(await pluginLinesOf()).toHaveLength(4);
    expect((await captureIo(async () => main(["plugin", "disable", "update-check"], d))).out).toBe(
      "PLUGIN update-check disabled",
    );
    const after = await pluginLinesOf();
    expect(after).toHaveLength(3);
    expect(after.some((line) => line.includes("update-check"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "state", "plugins.json"), "utf8"))).toEqual({
      disabled: ["update-check"],
    });
    expect((await captureIo(async () => main(["plugin", "list"], d))).out).toContain("PLUGIN update-check disabled");

    expect((await captureIo(async () => main(["plugin", "enable", "update-check"], d))).out).toBe(
      "PLUGIN update-check enabled",
    );
    expect(await pluginLinesOf()).toHaveLength(4);
  });

  test("a disabled ensure-up is not waited for by the supervised half", async () => {
    const home = homeWithState();
    writePluginsConfig(home, setPluginEnabled(home, "ensure-up", false));
    const started = Date.now();
    const state = await superviseHome(home, { startMissing: false });
    expect(state.ensureUp).toMatchObject({ alive: false });
    expect(state.off).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("an unregistered name is refused, and the registry list is offered instead", async () => {
    const w = new World();
    const d = w.deps();
    const failure: unknown = await main(["plugin", "disable", "ghost"], d).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String((failure as Error).message)).toContain("unknown plugin ghost");
    expect(String((failure as Error).message)).toContain("ensure-up, update-check, gateway-catchup, silence-check");
  });
});
