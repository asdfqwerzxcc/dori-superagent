import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const supervisorWith = (units: { name: string; pid: number; pane?: string }[], alive = true, startedAt?: number) => ({
  health: [
    {
      name: "supervisor" as const,
      pid: 4321,
      alive,
      ...(startedAt === undefined ? {} : { startedAt }),
      units: units.map((u) => ({ ...u, alive: true })),
    },
    { name: "watchdog" as const, pid: 4322, alive: true, units: [] },
  ],
  ensureUp: { alive: false },
  off: true,
});

describe("the UNITS line in dori up", () => {
  test("a complete record names every headless unit", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    w.supervised = supervisorWith([
      { name: "discord-gateway", pid: 11, pane: "w1:p2" },
      { name: "duty", pid: 12 },
      { name: "loop", pid: 13, pane: "w1:p3" },
      { name: "ensure-up", pid: 14, pane: "w1:p4" },
      { name: "update-check", pid: 15, pane: "w1:p5" },
      { name: "gateway-catchup", pid: 16, pane: "w1:p6" },
      { name: "silence-check", pid: 17, pane: "w1:p7" },
    ]);
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain("UNITS panes=6/7 headless=duty dead=none missing=none");
    expect(out).not.toContain("snapshot=startup");
  });

  test("a record read while units are still registering is labelled a startup snapshot", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    w.supervised = supervisorWith([{ name: "discord-gateway", pid: 11, pane: "w1:p2" }], true, Date.now());
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain(
      "UNITS snapshot=startup panes=1/7 headless=none dead=none missing=duty,loop,ensure-up,update-check,gateway-catchup,silence-check",
    );
  });

  test("a settled supervisor with a missing unit is not a startup snapshot", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    w.supervised = supervisorWith([{ name: "discord-gateway", pid: 11, pane: "w1:p2" }], true, Date.now() - 60_000);
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain("UNITS panes=1/7 headless=none dead=none missing=duty,loop,");
    expect(out).not.toContain("snapshot=startup");
  });

  test("a fresh start with a live supervisor prints the UNITS line after opening the lead", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "supervisor-heartbeat"), new Date().toISOString());
    w.supervised = supervisorWith([
      { name: "discord-gateway", pid: 11, pane: "w1:p2" },
      { name: "duty", pid: 12, pane: "w1:p3" },
      { name: "loop", pid: 13 },
      { name: "ensure-up", pid: 14, pane: "w1:p4" },
      { name: "update-check", pid: 15, pane: "w1:p5" },
      { name: "gateway-catchup", pid: 16, pane: "w1:p6" },
      { name: "silence-check", pid: 17, pane: "w1:p7" },
    ]);
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain("loops=supervised");
    expect(out).toContain("UNITS panes=6/7 headless=loop dead=none missing=none");
  });

  test("a dead supervisor record and a headless home print no UNITS line", async () => {
    const dead = new World();
    dead.addPane("w1:p1", "idle");
    const dd = dead.deps();
    dd.store.setRole("lead", href("w1:p1"));
    dead.supervised = supervisorWith([], false);
    const first = await captureIo(async () => {
      await up(dd, "/w");
      return 0;
    });
    expect(first.out).not.toContain("UNITS ");

    const headless = new World();
    headless.addPane("w1:p1", "idle");
    const hd = headless.deps();
    hd.store.setRole("lead", href("w1:p1"));
    writeFileSync(join(hd.store.root, "config.json"), JSON.stringify({ supervisors: { panes: false } }));
    headless.supervised = supervisorWith([{ name: "duty", pid: 12 }]);
    const second = await captureIo(async () => {
      await up(hd, "/w");
      return 0;
    });
    expect(second.out).toContain("units=headless");
    expect(second.out).not.toContain("UNITS ");
  });
});
