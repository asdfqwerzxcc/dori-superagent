import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../src/runtime/exec.ts";
import { PaneUnits, PaneUnknown, type PaneUnit } from "../src/supervisors/panes.ts";
import { HcPanes } from "../src/supervisors/panes-hc.ts";
import { HerdrPanes } from "../src/supervisors/panes-herdr.ts";
import { openUnitPanes } from "../src/supervisors/ops-panes.ts";
import type { Proc } from "../src/supervisor-run.ts";
import { FakeHc } from "./fake-hc.ts";

type Row = Record<string, unknown>;
const ok = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });

type World = {
  panes: Row[];
  workspaces: Row[];
  calls: string[][];
  shells: Map<string, number>;
  procs: Proc[] | undefined;
  next: number;
};
const world = (): World => ({ panes: [], workspaces: [], calls: [], shells: new Map(), procs: [], next: 1 });

function herdr(w: World): Exec {
  return async (cmd, argv) => {
    expect(cmd).toBe("herdr");
    w.calls.push([...argv]);
    const [verb, sub] = argv;
    if (verb === "workspace" && sub === "list") return ok({ workspaces: w.workspaces });
    if (verb === "workspace" && sub === "create") {
      const pane = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "1" };
      w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
      w.panes.push(pane);
      w.shells.set("w1:p1", 101);
      return ok({ root_pane: pane });
    }
    if (verb === "tab" && sub === "create") {
      const n = ++w.next;
      const label = argv[argv.indexOf("--label") + 1] ?? "";
      const pane = { pane_id: `w1:p${n}`, workspace_id: "w1", tab_id: `w1:t${n}`, label };
      w.panes.push(pane);
      w.shells.set(`w1:p${n}`, 100 + n);
      return ok({ root_pane: pane });
    }
    if (verb === "pane" && sub === "process-info") {
      const paneId = argv[argv.indexOf("--pane") + 1] ?? "";
      const shell = w.shells.get(paneId);
      return shell === undefined
        ? { code: 1, stdout: "", stderr: "pane not found" }
        : ok({ process_info: { pane_id: paneId, shell_pid: shell } });
    }
    if (verb === "pane" && sub === "list") return ok({ panes: w.panes });
    if (verb === "pane" && sub === "rename") {
      const pane = w.panes.find((p) => p["pane_id"] === argv[2]);
      if (pane !== undefined) pane["label"] = argv[3];
      return ok({});
    }
    if (verb === "pane" && (sub === "run" || sub === "close")) return ok({});
    if (verb === "tab" && (sub === "rename" || sub === "close")) return ok({});
    return { code: 1, stdout: "", stderr: `unexpected herdr ${argv.join(" ")}` };
  };
}

const adapter = (w: World): HerdrPanes =>
  new HerdrPanes({ home: "C:/home", env: { DORI_HOME: "C:/home" }, exec: herdr(w), procs: async () => w.procs });
const duty: PaneUnit = { name: "duty", command: "run duty", marker: ["cli.ts", "duty"] };

describe("herdr unit panes", () => {
  test("the ops workspace is created once and its first shell becomes the first unit's pane", async () => {
    const w = world();
    w.procs = [{ pid: 40, parent: 101, command: '"bun.exe" C:/repo/src/cli.ts duty --interval 60' }];
    const panes = adapter(w);
    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);
    const pane = await panes.open("duty");
    expect(pane).toEqual({ runtime: "herdr", id: "w1:p1", group: "w1", container: "w1:t1" });
    await panes.start(pane, "run duty");
    expect(w.calls).toContainEqual(["pane", "run", "w1:p1", "run duty"]);
    expect(await panes.pid(pane, ["cli.ts", "duty"])).toEqual({ kind: "running", pid: 40 });
    expect(await panes.panes("duty")).toEqual([pane]);
    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);
    await panes.close(pane);
    expect(w.calls).toContainEqual(["tab", "close", "w1:t1"]);
  });

  test("an existing ops workspace is reused and each later unit gets its own titled tab", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    const panes = adapter(w);
    await panes.ready();
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(0);
    const pane = await panes.open("loop");
    expect(pane.id).toBe("w1:p2");
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
    expect(await panes.panes("loop")).toEqual([pane]);
  });

  test("two same-titled panes: only the pane whose shell owns the process reports the pid", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.panes.push({ pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", label: "duty" });
    w.panes.push({ pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.shells.set("w1:p2", 202);
    w.procs = [{ pid: 3132, parent: 202, command: '"bun" C:/repo/src/cli.ts duty --interval 60' }];
    const panes = adapter(w);
    await panes.ready();
    const found = await panes.panes("duty");
    expect(found.map((p) => p.id)).toEqual(["w1:p1", "w1:p2"]);
    expect(await panes.pid(found[0]!, ["cli.ts", "duty"])).toEqual({ kind: "stopped" });
    expect(await panes.pid(found[1]!, ["cli.ts", "duty"])).toEqual({ kind: "running", pid: 3132 });
    const placed = await new PaneUnits({
      adapter: panes,
      log: () => {},
      sleep: async () => {},
      pidTimeoutMs: 0,
    }).place(duty);
    expect(placed).toEqual({ pid: 3132, pane: found[1]! });
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("a failed process list is unknown, and placement never starts a second copy", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.procs = undefined;
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toEqual({
      kind: "unknown",
      why: "process list unavailable",
    });
    const failure: unknown = await new PaneUnits({
      adapter: panes,
      log: () => {},
      sleep: async () => {},
      pidTimeoutMs: 0,
    })
      .place(duty)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
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
      // The terminal shell otherwise follows the host's $SHELL, which differs per CI platform.
      shell: "sh",
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
    expect(await panes.pid(pane, [])).toEqual({ kind: "running", pid: 4242 });
    expect(await panes.panes("duty")).toEqual([pane]);
    await panes.close(pane);
    expect(hc.terminals.has("t1")).toBe(false);
  });
});
