import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { superviseHome } from "../src/supervise-home.ts";

describe("startMissing in pane mode", () => {
  test("starts one ensure-up when no supervisor exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "dori-start-missing-"));
    mkdirSync(join(home, "state"), { recursive: true });
    const spawned: (readonly string[])[] = [];
    let now = 0;
    await superviseHome(home, {
      startMissing: true,
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
    expect(spawned).toContainEqual(["ensure-up"]);
  });
});
