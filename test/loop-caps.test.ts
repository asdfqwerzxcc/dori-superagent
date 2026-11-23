import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/hooks.ts";
import { DEFAULT_MAX_LANES, DEFAULT_MAX_STARTS, loopArgs, readLoopCaps } from "../src/loop-caps.ts";

const home = (config?: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-caps-"));
  if (config !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  return dir;
};

describe("loop caps", () => {
  test("the shipped budget is 5 lanes and 2 starts", () => {
    expect([DEFAULT_MAX_LANES, DEFAULT_MAX_STARTS]).toEqual([5, 2]);
  });

  test("config maxLanes 5 is passed to the loop unit as --max-lanes 5", () => {
    const args = loopArgs(readLoopCaps(home({ maxLanes: 5 })), ["loop"]);
    expect(args[args.indexOf("--max-lanes") + 1]).toBe("5");
    expect(args[args.indexOf("--max-starts") + 1]).toBe(String(DEFAULT_MAX_STARTS));
  });

  test("an absent config leaves the loop argv unchanged", () => {
    expect(readLoopCaps(home())).toEqual({});
    expect(loopArgs(readLoopCaps(home()), ["loop"])).toEqual(["loop"]);
  });

  test("a partial config fills the other cap from the shipped default", () => {
    expect(loopArgs(readLoopCaps(home({ maxStarts: 4 })), ["loop"])).toEqual([
      "loop",
      "--max-lanes",
      String(DEFAULT_MAX_LANES),
      "--max-starts",
      "4",
    ]);
  });

  test("a cap that is not a whole number >= 0 is a ConfigError", () => {
    expect(() => readLoopCaps(home({ maxLanes: -1 }))).toThrow(ConfigError);
    expect(() => readLoopCaps(home({ maxLanes: "5" }))).toThrow(ConfigError);
    expect(() => readLoopCaps(home({ maxStarts: 1.5 }))).toThrow(ConfigError);
  });
});
