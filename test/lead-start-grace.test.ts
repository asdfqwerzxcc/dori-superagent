import { describe, expect, test } from "bun:test";
import { up } from "../src/cli-up.ts";
import { clearLeadStarting, leadStarting, markLeadStarting } from "../src/lead-starting.ts";
import { ensureUpCheck } from "../src/supervisors/ensure-up.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

/** The probe's snapshot (D2): shell 100 with a live agent child, matching the World fixture's process-info. */
const LIVE_TREE = async () => [
  { pid: 100, exe: "powershell.exe" },
  { pid: 101, parent: 100, exe: "omo.exe" },
];

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
    expect(await ensureUpCheck({ home, exec: d.exec, tree: LIVE_TREE, up: upOnce, log: () => {} })).toBe("down");
    expect(calls).toBe(1);
    expect(await ensureUpCheck({ home, exec: d.exec, tree: LIVE_TREE, up: upOnce, log: () => {} })).toBe("alive");
    expect(calls).toBe(1);
    clearLeadStarting(home);
    expect(await ensureUpCheck({ home, exec: d.exec, tree: LIVE_TREE, up: upOnce, log: () => {} })).toBe("down");
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
  test("up clears the grace when the lead is alive", async () => {
    const w = new World();
    w.addPane("w1:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    w.panes.get("w1:p2")!.status = "idle";
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toBe("UP lead alive; ensuring units only (lead=w1:p2) units=panes");
    expect(leadStarting(d.store.root).starting).toBe(false);
  });

  test("ensure-up clears the grace and recovers a later shell", async () => {
    const w = new World();
    w.addPane("w1:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    w.panes.get("w1:p2")!.status = "idle";
    const alive = await ensureUpCheck({
      home: d.store.root,
      exec: d.exec,
      tree: LIVE_TREE,
      up: async () => ({ code: 0, detail: "" }),
      log: () => {},
    });
    expect(alive).toBe("alive");
    expect(leadStarting(d.store.root).starting).toBe(false);
    w.panes.get("w1:p2")!.status = "shell";
    let calls = 0;
    const down = await ensureUpCheck({
      home: d.store.root,
      exec: d.exec,
      tree: LIVE_TREE,
      up: async () => {
        calls += 1;
        await captureIo(async () => {
          await up(d, "/w");
          return 0;
        });
        return { code: 0, detail: "" };
      },
      log: () => {},
    });
    expect(down).toBe("down");
    expect(calls).toBe(1);
    expect(d.store.roles().lead).toEqual(href("w1:p6"));
  });

  test("retireOld skips a fresh start grace", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    markLeadStarting(d.store.root);
    const { out } = await captureIo(async () => {
      await up(d, "/w", true);
      return 0;
    });
    expect(out).toContain("UP retired previous lead w1:p1");
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
    expect(leadStarting(d.store.root).starting).toBe(true);
  });

  test("a failed lead creation clears the grace", async () => {
    const w = new World();
    const real = w.exec;
    w.exec = async (cmd, argv, options) => {
      if (cmd === "herdr" && argv[0] === "workspace" && argv[1] === "create")
        return { code: 1, stdout: "", stderr: "create failed" };
      return real(cmd, argv, options);
    };
    const d = w.deps();
    await expect(
      captureIo(async () => {
        await up(d, "/w");
        return 0;
      }),
    ).rejects.toThrow();
    expect(leadStarting(d.store.root).starting).toBe(false);
  });
});
