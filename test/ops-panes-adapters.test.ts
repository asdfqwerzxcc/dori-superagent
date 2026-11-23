import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { HcPanes } from "../src/supervisors/panes-hc.ts";
import { HerdrPanes } from "../src/supervisors/panes-herdr.ts";
import { openUnitPanes } from "../src/supervisors/ops-panes.ts";
import type { Proc } from "../src/supervisor-run.ts";
import { FakeHc } from "./fake-hc.ts";

type Row = Record<string, unknown>;
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });

type World = { panes: Row[]; workspaces: Row[]; calls: string[][] };

function herdr(world: World): Exec {
  return async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    world.calls.push([...argv]);
    const [verb, sub, id] = argv;
    if (verb === "workspace" && sub === "list") return ok({ workspaces: world.workspaces });
    if (verb === "workspace" && sub === "create") {
      const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "1" };
      world.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
      world.panes.push(pane);
      return ok({ root_pane: pane });
    }
    if (verb === "tab" && sub === "create") {
      const n = world.panes.length + 1;
      const label = argv[argv.indexOf("--label") + 1] ?? "";
      const pane = { pane_id: `w1:p${n}`, workspace_id: "w1", tab_id: `w1:t${n}`, label };
      world.panes.push(pane);
      return ok({ root_pane: pane });
    }
    if (verb === "tab" && sub === "rename") return ok({});
    if (verb === "pane" && sub === "rename") {
      const pane = world.panes.find((p) => p["pane_id"] === id);
      if (pane !== undefined) pane["label"] = argv[3];
      return ok({});
    }
    if (verb === "pane" && (sub === "run" || sub === "close")) return ok({});
    if (verb === "pane" && sub === "list") return ok({ panes: world.panes });
    if (verb === "tab" && sub === "close") return ok({});
    return { code: 1, stdout: "", stderr: `unexpected herdr ${argv.join(" ")}` };
  };
}

const world = (): World => ({ panes: [], workspaces: [], calls: [] });
const procs = (...commands: string[]): Proc[] => commands.map((command, i) => ({ pid: 40 + i, command }));

describe("herdr unit panes", () => {
  test("the ops workspace is created once and its first shell becomes the first unit's pane", async () => {
    const w = world();
    const panes = new HerdrPanes({
      home: "C:/home",
      env: { DORI_HOME: "C:/home" },
      exec: herdr(w),
      procs: async () => procs('"bun.exe" C:/repo/src/cli.ts duty --interval 60'),
    });
    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);
    expect(w.calls.find((c) => c[0] === "workspace" && c[1] === "create")).toContain("--env");

    const pane = await panes.open("duty");
    expect(pane).toEqual({ runtime: "herdr", id: "w1:p1", group: "w1", container: "w1:t1" });
    expect(w.panes[0]!["label"]).toBe("duty");

    await panes.start(pane, "run duty");
    expect(w.calls).toContainEqual(["pane", "run", "w1:p1", "run duty"]);
    expect(await panes.pid(pane, ["cli.ts", "duty"])).toBe(40);
    expect(await panes.find("duty")).toEqual(pane);

    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);

    await panes.close(pane);
    expect(w.calls).toContainEqual(["tab", "close", "w1:t1"]);
  });

  test("an existing ops workspace is reused and each later unit gets its own titled tab", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    const panes = new HerdrPanes({
      home: "C:/home",
      env: { DORI_HOME: "C:/home" },
      exec: herdr(w),
      procs: async () => procs(),
    });
    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(0);

    const pane = await panes.open("loop");
    expect(pane.id).toBe("w1:p1");
    expect(w.calls).toContainEqual([
      "tab",
      "create",
      "--label",
      "loop",
      "--cwd",
      "C:/home",
      "--workspace",
      "w1",
      "--env",
      "DORI_HOME=C:/home",
      "--no-focus",
    ]);
    expect(w.panes.map((p) => p["label"])).toEqual(["loop"]);
  });

  test("a pane in another workspace is not a match, and a dead pane has no pid", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w2:p1", workspace_id: "w2", title: "duty" });
    w.panes.push({ pane_id: "w1:p2", workspace_id: "w1", title: "duty" });
    const panes = new HerdrPanes({
      home: "C:/home",
      env: { DORI_HOME: "C:/home" },
      exec: herdr(w),
      procs: async () => procs(),
    });
    await panes.ready();
    const found = await panes.find("duty");
    expect(found?.id).toBe("w1:p2");
    expect(await panes.pid(found!, ["cli.ts", "duty"])).toBeUndefined();
  });
});

describe("the pane layer factory", () => {
  test("no runtime on PATH is one warning and no pane layer", async () => {
    const logs: string[] = [];
    const panes = await openUnitPanes({
      home: "C:/dori-no-runtime",
      env: { PATH: "" },
      log: (line) => logs.push(line),
      sleep: async () => {},
      exists: () => false,
    });
    expect(panes).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("SUPERVISED panes_unavailable");
    expect(logs[0]).toContain("headless=1");
  });

  test("a herdr that does not answer falls back with one warning", async () => {
    const logs: string[] = [];
    const panes = await openUnitPanes({
      home: "C:/dori-no-runtime",
      env: { DORI_RUNTIME: "herdr" },
      log: (line) => logs.push(line),
      sleep: async () => {},
      exec: async () => ({ code: 1, stdout: "", stderr: "no herdr socket" }),
    });
    expect(panes).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("panes_unavailable runtime=herdr");
  });
});

describe("hc unit panes", () => {
  test("a unit terminal is labelled, named, started, found and torn down", async () => {
    const hc = new FakeHc();
    const panes = new HcPanes({
      home: "/home/dori",
      env: { DORI_HOME: "/home/dori" },
      exec: hc.exec,
      sleep: async () => {},
      log: () => {},
    });
    await panes.ready();
    expect(hc.calls[0]).toEqual(["ls", "--label", "dori.group=dori-ops"]);

    const pane = await panes.open("duty");
    expect(pane).toEqual({ runtime: "hc", id: "t1", group: "dori-ops" });
    const run = hc.calls.find((c) => c[0] === "run")!;
    expect(run).toContain("dori.group=dori-ops");
    expect(run).toContain("dori.unit=duty");
    expect(run).toContain("--name");
    expect(run.at(-1)).toBe("sh");

    await panes.start(pane, "run duty");
    expect(hc.sent).toEqual([{ id: "t1", text: "run duty" }]);
    expect(await panes.pid(pane, [])).toBe(4242);
    expect(await panes.find("duty")).toEqual(pane);

    await panes.close(pane);
    expect(hc.terminals.has("t1")).toBe(false);
  });
});
