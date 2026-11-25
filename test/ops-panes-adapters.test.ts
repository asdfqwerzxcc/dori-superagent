import { describe, expect, test } from "bun:test";
import { PaneUnits } from "../src/supervisors/pane-units.ts";
import { PaneUnknown } from "../src/supervisors/panes.ts";
import { openUnitPanes } from "../src/supervisors/ops-panes.ts";
import { duty, herdrAdapter as adapter, herdrWorld as world } from "./ops-panes-herdr-fixture.ts";

describe("herdr unit panes", () => {
  test("the ops workspace is created once and its first shell becomes the first unit's pane", async () => {
    const w = world();
    w.tree = [{ pid: 40, parent: 101, exe: "bun.exe" }];
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
    w.tree = [{ pid: 3132, parent: 202, exe: "bun" }];
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
      startWindowMs: 0,
    }).place(duty);
    expect(placed).toEqual({ pid: 3132, pane: found[1]! });
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("a failed process list is unknown, and placement never starts a second copy", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = undefined;
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toEqual({
      kind: "unknown",
      why: "process tree unavailable",
    });
    const failure: unknown = await new PaneUnits({
      adapter: panes,
      log: () => {},
      sleep: async () => {},
      startWindowMs: 0,
    })
      .place(duty)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("only a lone bun child is the unit: another executable is stopped and two bun children are unknown", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "omo.exe" }];
    const panes = adapter(w);
    await panes.ready();
    const pane = (await panes.panes("duty"))[0]!;
    expect(await panes.pid(pane, ["cli.ts", "duty"])).toEqual({ kind: "stopped" });
    w.tree = [
      { pid: 31, parent: 101, exe: "bun.exe" },
      { pid: 32, parent: 101, exe: "bun.exe" },
    ];
    expect(await panes.pid(pane, ["cli.ts", "duty"])).toMatchObject({ kind: "unknown" });
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
