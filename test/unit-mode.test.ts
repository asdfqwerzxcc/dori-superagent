import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/hooks.ts";
import { PaneUnits } from "../src/supervisors/panes.ts";
import type { UnitPanes } from "../src/supervisors/ops-panes.ts";
import { readUnitPanes, unitMode, unitPaneLayer } from "../src/supervisors/unit-mode.ts";
import { FakeAdapter } from "./ops-panes-fixture.ts";

const home = (config?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-unit-mode-"));
  if (config !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
};

const layer = (): UnitPanes => ({
  units: new PaneUnits({ adapter: new FakeAdapter(), log: () => {}, sleep: async () => {} }),
  shell: "sh",
});

const quiet = () => {};

describe("supervisors.panes config", () => {
  test("an absent file or key keeps the pane mode, and true is explicit", () => {
    expect(readUnitPanes(home())).toBe(true);
    expect(readUnitPanes(home({}))).toBe(true);
    expect(readUnitPanes(home({ supervisors: {} }))).toBe(true);
    expect(readUnitPanes(home({ supervisors: { panes: true } }))).toBe(true);
    expect(unitMode(home())).toBe("panes");
  });

  test("false is headless", () => {
    expect(readUnitPanes(home({ supervisors: { panes: false } }))).toBe(false);
    expect(unitMode(home({ supervisors: { panes: false } }))).toBe("headless");
  });

  test("a supervisors value that is not an object is a ConfigError", () => {
    expect(() => readUnitPanes(home({ supervisors: false }))).toThrow(ConfigError);
    expect(() => readUnitPanes(home({ supervisors: [] }))).toThrow(ConfigError);
  });

  test("panes that is not a boolean is a ConfigError naming the key", () => {
    const dir = home({ supervisors: { panes: "no" } });
    expect(() => readUnitPanes(dir)).toThrow(ConfigError);
    expect(() => readUnitPanes(dir)).toThrow("supervisors.panes");
  });
});

describe("unit launch path", () => {
  test("panes=false never probes a runtime and runs the headless children", async () => {
    const logs: string[] = [];
    let opened = 0;
    const panes = await unitPaneLayer({
      home: home({ supervisors: { panes: false } }),
      env: {},
      log: (line) => logs.push(line),
      sleep: async () => {},
      open: async () => {
        opened++;
        return layer();
      },
    });
    expect(panes).toBeUndefined();
    expect(opened).toBe(0);
    expect(logs).toContain("SUPERVISED units headless reason=config supervisors.panes=false");
  });

  test("panes=true opens the pane layer", async () => {
    const dir = home();
    const expected = layer();
    let opened = 0;
    const panes = await unitPaneLayer({
      home: dir,
      env: {},
      log: quiet,
      sleep: async () => {},
      open: async (o) => {
        opened++;
        expect(o.home).toBe(dir);
        return expected;
      },
    });
    expect(opened).toBe(1);
    expect(panes).toBe(expected);
  });

  test("an unknown panes value keeps the pane mode behind one warning", async () => {
    const logs: string[] = [];
    let opened = 0;
    const panes = await unitPaneLayer({
      home: home({ supervisors: { panes: "no" } }),
      env: {},
      log: (line) => logs.push(line),
      sleep: async () => {},
      open: async () => {
        opened++;
        return layer();
      },
    });
    expect(opened).toBe(1);
    expect(panes).not.toBeUndefined();
    expect(logs.some((line) => line.includes("units_config_invalid"))).toBe(true);
  });

  test("a runtime that offers no panes leaves the headless children", async () => {
    const panes = await unitPaneLayer({
      home: home(),
      env: {},
      log: quiet,
      sleep: async () => {},
      open: async () => undefined,
    });
    expect(panes).toBeUndefined();
  });
});
