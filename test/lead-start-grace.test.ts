import { describe, expect, test } from "bun:test";
import { up } from "../src/cli-up.ts";
import { clearLeadStarting, leadStarting, markLeadStarting } from "../src/lead-starting.ts";
import { ensureUpCheck } from "../src/supervisors/ensure-up.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("lead start grace", () => {
  test("ensure-up: two shell ticks do not raise two leads", async () => {
    const w = new World();
    w.addPane("w9:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w9:p1"));
    const home = d.store.root;
    let calls = 0;
    const upOnce = async () => {
      calls += 1;
      markLeadStarting(home);
      return { code: 0, detail: "" };
    };
    expect(await ensureUpCheck({ home, exec: d.exec, up: upOnce, log: () => {} })).toBe("down");
    expect(calls).toBe(1);
    expect(await ensureUpCheck({ home, exec: d.exec, up: upOnce, log: () => {} })).toBe("alive");
    expect(calls).toBe(1);
    clearLeadStarting(home);
    expect(await ensureUpCheck({ home, exec: d.exec, up: upOnce, log: () => {} })).toBe("down");
    expect(calls).toBe(2);
  });

  test("up: a new shell lead is not replaced on the next up", async () => {
    const w = new World();
    w.addPane("w1:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
    expect(leadStarting(d.store.root).starting).toBe(true);
    const panes = [...w.panes.keys()];
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toBe("UP lead starting (attempts=1); not opening another lead");
    expect([...w.panes.keys()]).toEqual(panes);
    clearLeadStarting(d.store.root);
    const { out: after } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(d.store.roles().lead).toEqual(href("w1:p6"));
    expect(after).toContain("UP runtime=herdr lead=w1:p6");
  });
});
