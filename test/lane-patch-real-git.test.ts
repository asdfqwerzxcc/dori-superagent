import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { lanePatchId } from "../src/lane-patch.ts";
import { spawnExec } from "../src/runtime/exec.ts";

const dir = mkdtempSync(join(tmpdir(), "dori-real-patch-"));
const deps = { exec: spawnExec } as unknown as Deps;

const git = async (...args: string[]): Promise<string> => {
  const r = await spawnExec("git", ["-C", dir, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};

beforeAll(async () => {
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "patch@test.local");
  await git("config", "user.name", "patch test");
  writeFileSync(join(dir, "f.txt"), "base\nline2\nline3\nline4\nline5\n");
  await git("add", ".");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", "lane");
  writeFileSync(join(dir, "f.txt"), "base\nline2\nline3\nline4\nlane\n");
  await git("commit", "-qam", "lane");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("patch-id against real git", () => {
  test("a clean rebase keeps it and a changed patch moves it", async () => {
    const firstBase = await git("rev-parse", "HEAD~1");
    const firstTip = await git("rev-parse", "HEAD");
    const first = await lanePatchId(deps, dir, firstBase, firstTip);
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    await git("checkout", "-q", "main");
    writeFileSync(join(dir, "other.txt"), "main\n");
    await git("add", ".");
    await git("commit", "-qm", "main");
    await git("checkout", "-q", "lane");
    await git("rebase", "-q", "main");

    const rebasedBase = await git("rev-parse", "main");
    const rebasedTip = await git("rev-parse", "HEAD");
    expect(await lanePatchId(deps, dir, rebasedBase, rebasedTip)).toBe(first);

    writeFileSync(join(dir, "f.txt"), "base\nline2\nline3\nline4\nlane changed\n");
    await git("commit", "-qam", "change");
    const changedTip = await git("rev-parse", "HEAD");
    expect(await lanePatchId(deps, dir, rebasedBase, changedTip)).not.toBe(first);
  });
});
