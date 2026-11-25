import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseHome } from "../src/supervise-home.ts";

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-start-missing-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const run = async (home: string, startMissing: boolean): Promise<(readonly string[])[]> => {
  const spawned: (readonly string[])[] = [];
  let now = 0;
  await superviseHome(home, {
    startMissing,
    alive: () => false,
    spawn: (_entry, _cwd, args) => {
      if (args === undefined) return undefined;
      spawned.push(args);
      return 9_999;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    log: () => {},
  });
  return spawned;
};

describe("startMissing in pane mode", () => {
  test("startMissing asks for supervisors and never starts a second ensure-up", async () => {
    const spawned = await run(homeWithState(), true);
    expect(spawned).not.toContainEqual(["ensure-up"]);
  });

  test("pane mode without a supervisor starts one ensure-up", async () => {
    const spawned = await run(homeWithState(), false);
    expect(spawned).toContainEqual(["ensure-up"]);
  });
});
