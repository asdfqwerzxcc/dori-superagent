import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  test("round-trips through the real file", () => {
    const dir = home();
    const store = panePendingStore(dir);
    expect(store.read()).toEqual([]);
    store.write(["w1:p1", "w1:p2"]);
    expect(store.read()).toEqual(["w1:p1", "w1:p2"]);
    store.write([]);
    expect(store.read()).toEqual([]);
  });

  test("a malformed file reads as empty instead of throwing", () => {
    const dir = home();
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "panes-pending.json"), "{not json");
    expect(panePendingStore(dir).read()).toEqual([]);
  });

  test("a write failure never throws and reads back empty", () => {
    const dir = home();
    mkdirSync(join(dir, "state", "panes-pending.json"), { recursive: true });
    const store = panePendingStore(dir);
    expect(() => store.write(["w1:p1"])).not.toThrow();
    expect(store.read()).toEqual([]);
  });
});
