import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panePendingStore } from "../src/supervisors/ops-panes.ts";

const homes: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dori-pending-"));
  homes.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the pending-pane store", () => {
  test("round-trips through the real file and leaves no temp file", () => {
    const dir = home();
    const warns: string[] = [];
    const store = panePendingStore(dir, (line) => warns.push(line));
    expect(store.read()).toEqual([]);
    store.write(["w1:p1", "w1:p2"]);
    expect(store.read()).toEqual(["w1:p1", "w1:p2"]);
    store.write([]);
    expect(store.read()).toEqual([]);
    expect(readdirSync(join(dir, "state")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(warns).toEqual([]);
  });

  test("a malformed file reads as undefined and warns instead of pretending empty", () => {
    const dir = home();
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "panes-pending.json"), "{not json");
    const warns: string[] = [];
    expect(panePendingStore(dir, (line) => warns.push(line)).read()).toBeUndefined();
    expect(warns.some((l) => /panes_pending_unreadable/.test(l))).toBe(true);
  });

  test("a non-list file reads as undefined", () => {
    const dir = home();
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "panes-pending.json"), JSON.stringify({ panes: ["w1:p1"] }));
    expect(panePendingStore(dir).read()).toBeUndefined();
  });

  test("a write failure never throws, warns, and reads back undefined", () => {
    const dir = home();
    mkdirSync(join(dir, "state", "panes-pending.json"), { recursive: true });
    const warns: string[] = [];
    const store = panePendingStore(dir, (line) => warns.push(line));
    expect(() => store.write(["w1:p1"])).not.toThrow();
    expect(warns.some((l) => /panes_pending_write_failed/.test(l))).toBe(true);
    expect(store.read()).toBeUndefined();
    expect(warns.some((l) => /panes_pending_unreadable/.test(l))).toBe(true);
  });
});
