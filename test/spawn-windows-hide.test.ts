import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { findSpawnProblems, scanSource } from "./spawn-scan.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("every spawn is windowless", () => {
  test("no repository spawn call omits windowsHide: true", () => {
    expect(findSpawnProblems(ROOT)).toEqual([]);
  });

  test("the scanner catches a missing option, a bare call and an imported alias", () => {
    const bad = [
      'import { spawnSync as launch } from "node:child_process";',
      "Bun.spawn([x], { stdout: 'pipe' });",
      'launch("node", ["--version"], { encoding: "utf8" });',
      'Bun.spawnSync(["git", "status"]);',
    ].join("\n");
    expect(scanSource("bad.ts", bad)).toHaveLength(3);
    const good = [
      'import { spawnSync as launch } from "node:child_process";',
      "Bun.spawn([x], { windowsHide: true, stdout: 'pipe' });",
      'launch("node", ["--version"], { encoding: "utf8", windowsHide: true });',
      'Bun.spawnSync(["git", "status"], { windowsHide: true });',
    ].join("\n");
    expect(scanSource("good.ts", good)).toEqual([]);
  });
});
