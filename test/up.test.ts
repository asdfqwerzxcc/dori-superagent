import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { clearLeadRestartBusy, markLeadRestartBusy } from "../src/lead-restart-busy.ts";
import { groupId } from "../src/runtime/group.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

describe("dori up", () => {
  test("herdr: eight calls, the lead alone carries the task background default, all four roles registered", async () => {
    const w = new World();
    const d = w.deps();
    const root = d.store.root;
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const prompt = (name: string) => `omo --append-system-prompt '${join(root, "prompts", name)}'`;
    const split = (near: string, ...env: string[]) => [
      "pane",
      "split",
      near,
      "--direction",
      "down",
      "--ratio",
      "0.3",
      "--cwd",
      "/w",
      "--no-focus",
      ...env.flatMap((e) => ["--env", e]),
    ];
    expect(w.calls.map((c) => [c.cmd, ...c.argv])).toEqual(
      [
        [
          "workspace",
          "create",
          "--label",
          "dori",
          "--cwd",
          "/w",
          "--env",
          "OMO_TASK_DEFAULT_BACKGROUND=1",
          "--no-focus",
        ],
        ["pane", "run", "w1:p2", prompt("lead.md")],
        [
          "tab",
          "create",
          "--label",
          "duty",
          "--cwd",
          "/w",
          "--no-focus",
          "--workspace",
          "w1",
          "--env",
          `DORI_HOME=${root}`,
        ],
        ["pane", "run", "w1:p3", prompt("duty.md")],
        split("w1:p3", `DORI_HOME=${root}`),
        ["pane", "run", "w1:p4", "dori duty --interval 60"],
        split("w1:p4", `DORI_HOME=${root}`, "HERDR_WORKSPACE_ID=w1"),
        ["pane", "run", "w1:p5", "dori loop"],
      ].map((argv) => ["herdr", ...argv]),
    );
    // A lead that blocks its turn on a foreground child queues the human behind it; the other panes need no such guard.
    expect(w.calls.filter((c) => c.argv.includes("OMO_TASK_DEFAULT_BACKGROUND=1"))).toHaveLength(1);
    expect(w.calls[0]?.argv).toContain("OMO_TASK_DEFAULT_BACKGROUND=1");
    expect(JSON.parse(readFileSync(join(root, "roles.json"), "utf8"))).toEqual({
      lead: "w1:p2",
      duty: "w1:p3",
      "duty-loop": "w1:p4",
      "hourly-loop": "w1:p5",
    });
    expect(out).toBe(
      `UP runtime=herdr lead=w1:p2 duty=w1:p3 loop=w1:p4 hourly=w1:p5 home=${root} units=panes\nENSURE-UP off (ensure-up.off)`,
    );
    expect(w.superviseCalls).toEqual([{ startMissing: false, hasLog: true }]);
  });

  test("a registered lead that is only a shell is replaced by a new lead", async () => {
    const w = new World();
    w.addPane("w1:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
    expect(out).toContain("UP runtime=herdr lead=w1:p2");
    // The bare shell is left alone: a new workspace is what replaces it, not a second lead in that pane.
    expect(w.panes.has("w1:p1")).toBe(true);
  });

  test("a restart in progress does not open a second lead", async () => {
    const w = new World();
    w.addPane("w1:p1", "shell");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    const busy = markLeadRestartBusy(d.store.root, "w1:p1");
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(d.store.roles().lead).toEqual(href("w1:p1"));
    expect(out).toBe("UP lead restart in progress; not opening a second lead");
    expect(w.calls.filter((c) => c.cmd === "herdr" && (c.argv[1] === "create" || c.argv[1] === "split"))).toEqual([]);
    clearLeadRestartBusy(d.store.root, busy);
    const { out: after } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
    expect(after).toContain("UP runtime=herdr lead=w1:p2");
  });

  test("a live registered lead with the supervisor down starts it: no new workspace or duty", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(w.calls.filter((c) => c.cmd === "herdr" && (c.argv[1] === "create" || c.argv[1] === "split"))).toEqual([]);
    expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "pane" && c.argv[1] === "run")).toHaveLength(0);
    expect(d.store.roles()).toEqual({ lead: href("w1:p1") });
    // startMissing is the one argument that makes superviseHome call ensureSupervisors; a dead supervisor needs it.
    expect(w.superviseCalls).toEqual([{ startMissing: true, hasLog: true }]);
    expect(out).toBe("UP lead alive; ensuring units only (lead=w1:p1) units=panes");
  });

  test("a live registered lead with the supervisor up is left as is: ensure is not asked", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    const root = d.store.root;
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "supervisor-heartbeat"), new Date().toISOString());
    d.store.setRole("lead", href("w1:p1"));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(w.superviseCalls).toEqual([{ startMissing: false, hasLog: true }]);
    expect(out).toBe("UP lead alive; ensuring units only (lead=w1:p1) units=panes");
  });

  test("--retire-old true replaces the live lead and closes the previous pane", async () => {
    const w = new World();
    w.addPane("w1:p1", "idle");
    const d = w.deps();
    d.store.setRole("lead", href("w1:p1"));
    const { out } = await captureIo(async () => {
      await up(d, "/w", true);
      return 0;
    });
    expect(w.panes.has("w1:p1")).toBe(false);
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
    expect(out).toContain("UP retired previous lead w1:p1");
  });

  test("a configured loop budget rides on the hourly pane command", async () => {
    const w = new World();
    const d = w.deps();
    writeFileSync(join(d.store.root, "config.json"), JSON.stringify({ maxLanes: 5 }));
    await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const commands = w.calls
      .filter((c) => c.cmd === "herdr" && c.argv[0] === "pane" && c.argv[1] === "run")
      .map((c) => c.argv.at(-1));
    expect(commands).toContain("dori loop --max-lanes 5 --max-starts 2");
  });

  test("hc: four terminals in this home's group, prefixed roles, no herdr workspace variable", async () => {
    const w = new World();
    const d = w.deps({ runtime: "hc" });
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    const runs = w.calls.filter((c) => c.cmd === "hc" && c.argv[1] === "run").map((c) => c.argv);
    expect(runs).toHaveLength(4);
    for (const argv of runs) expect(argv).toContain(`dori.group=${groupId(d.store.root)}`);
    expect(runs.map((a) => a.find((x) => x.startsWith("dori.role=")))).toEqual([
      "dori.role=lead",
      "dori.role=duty",
      "dori.role=duty-loop",
      "dori.role=hourly-loop",
    ]);
    expect(runs[0] ?? []).toContain("OMO_TASK_DEFAULT_BACKGROUND=1");
    expect(runs.slice(1).some((a) => a.some((x) => x.startsWith("OMO_TASK_DEFAULT_BACKGROUND=")))).toBe(false);
    expect(runs.some((a) => a.some((x) => x.startsWith("HERDR_WORKSPACE_ID=")))).toBe(false);
    expect(w.calls.some((c) => c.cmd === "herdr")).toBe(false);
    expect(w.hc.calls.filter((c) => c[0] === "send").map((c) => c.at(-1))).toEqual([
      expect.stringContaining("lead.md"),
      expect.stringContaining("duty.md"),
      "dori duty --interval 60",
      "dori loop",
    ]);
    expect(JSON.parse(readFileSync(join(d.store.root, "roles.json"), "utf8"))).toEqual({
      lead: "hc:t1",
      duty: "hc:t2",
      "duty-loop": "hc:t3",
      "hourly-loop": "hc:t4",
    });
    expect(out).toStartWith("UP runtime=hc lead=hc:t1 duty=hc:t2 loop=hc:t3 hourly=hc:t4 ");
  });

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
    expect(w.superviseCalls).toEqual([{ startMissing: false, hasLog: true }]);
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
