import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("dori up: supervised units", () => {
  test("loops supervised: no loop panes, the stale loop roles dropped, the supervisors asked to ensure the stack", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "supervisor-heartbeat"), new Date().toISOString());
    d.store.setRole("duty-loop", { runtime: "herdr", id: "w1:p8" });
    d.store.setRole("hourly-loop", { runtime: "herdr", id: "w1:p9" });
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "pane" && c.argv[1] === "split")).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(root, "roles.json"), "utf8"))).toEqual({ lead: "w1:p2", duty: "w1:p3" });
    expect(w.superviseCalls).toEqual([{ startMissing: false }]);
    expect(out).toStartWith("UP loops are supervised; skipping the loop panes (lead+duty only)\n");
    expect(out).toContain("ensure-up=off");
    expect(out).toContain("units=panes");
  });

  test("supervisors.panes=false prints the headless unit mode", async () => {
    const w = new World();
    const d = w.deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ supervisors: { panes: false } }));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain("units=headless");
    expect(out).not.toContain("units=panes");
  });
});
