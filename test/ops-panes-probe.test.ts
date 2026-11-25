import { describe, expect, test } from "bun:test";
import { PaneUnits } from "../src/supervisors/pane-units.ts";
import { PaneUnknown } from "../src/supervisors/panes.ts";
import { duty, herdrAdapter as adapter, herdrWorld as world } from "./ops-panes-herdr-fixture.ts";

describe("the herdr probe matches pid and command", () => {
  test("a foreground command line naming the unit is its pid, even before the process tree shows a child", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.foreground.set("w1:p1", [
      { name: "bun", argv: ["C:/bun/bun.exe", "C:/dori/cli.ts", "duty", "--interval", "60"], pid: 777 },
    ]);
    const panes = adapter(w);
    await panes.ready();
    const pane = (await panes.panes("duty"))[0]!;
    expect(await panes.pid(pane, ["C:/dori/cli.ts", "duty", "--interval", "60"])).toEqual({
      kind: "running",
      pid: 777,
    });
    expect(await panes.pid(pane, ["C:/dori/cli.ts", "loop"])).toMatchObject({ kind: "unknown" });
  });

  test("a pane busy with another readable command is doubt, and placement never types over it", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.foreground.set("w1:p1", [{ name: "bun", argv: ["bun", "other.ts"], pid: 778 }]);
    const panes = adapter(w);
    await panes.ready();
    const units = new PaneUnits({ adapter: panes, log: () => {}, sleep: async () => {}, startWindowMs: 0 });
    const failure: unknown = await units.place(duty).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(String(failure)).toContain("foreground cannot be identified as its shell: bun");
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("a direct bun child is not adopted while its pane runs a foreign foreground command", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "bun.exe" }];
    w.foreground.set("w1:p1", [{ name: "bun", argv: ["bun", "other.ts"], pid: 778 }]);
    const panes = adapter(w);
    await panes.ready();
    const units = new PaneUnits({ adapter: panes, log: () => {}, sleep: async () => {}, startWindowMs: 0 });
    const failure: unknown = await units.place(duty).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(w.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("a pid-only foreign foreground is doubt, never the unit", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "bun.exe" }];
    w.foreground.set("w1:p1", [{ name: "", argv: [], pid: 779 }]);
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toMatchObject({ kind: "unknown" });
  });

  test("a readable foreground without a pid is doubt, even beside a bun child", async () => {
    const withChild = world();
    withChild.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    withChild.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    withChild.shells.set("w1:p1", 101);
    withChild.tree = [{ pid: 31, parent: 101, exe: "bun.exe" }];
    withChild.foreground.set("w1:p1", [{ name: "top", argv: ["top"] }]);
    const childAdapter = adapter(withChild);
    await childAdapter.ready();
    expect(await childAdapter.pid((await childAdapter.panes("duty"))[0]!, ["cli.ts", "duty"])).toMatchObject({
      kind: "unknown",
    });

    const noChild = world();
    noChild.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    noChild.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    noChild.shells.set("w1:p1", 101);
    noChild.foreground.set("w1:p1", [{ name: "top", argv: ["top"] }]);
    const emptyAdapter = adapter(noChild);
    await emptyAdapter.ready();
    const units = new PaneUnits({ adapter: emptyAdapter, log: () => {}, sleep: async () => {}, startWindowMs: 0 });
    const failure: unknown = await units.place(duty).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(noChild.calls.filter((c) => c[0] === "pane" && c[1] === "run")).toHaveLength(0);
  });

  test("the pane shell in front is not a foreign command, so its bun child is the unit", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "bun.exe" }];
    w.foreground.set("w1:p1", [
      { name: "powershell.exe", argv: ["powershell.exe", "-NoExit", "-Command", "prompt"], pid: 101 },
    ]);
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toEqual({
      kind: "running",
      pid: 31,
    });
  });

  test("the shell's sole bun child with no readable command line in front is the unit", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "bun.exe" }];
    w.foreground.set("w1:p1", [{ name: "bun", argv: [], pid: 31 }]);
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toEqual({
      kind: "running",
      pid: 31,
    });

    w.foreground.set("w1:p1", [{ name: "bun", argv: [], pid: 99 }]);
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toMatchObject({
      kind: "unknown",
    });

    w.foreground.set("w1:p1", [{ name: "bun", argv: [] }]);
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toMatchObject({
      kind: "unknown",
    });
  });

  test("the program decides the interpreter: a foreign one is not the unit", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [{ pid: 31, parent: 101, exe: "node" }];
    w.foreground.set("w1:p1", [{ name: "node", argv: ["node", "cli.ts", "duty"], pid: 31 }]);
    const panes = adapter(w);
    await panes.ready();
    const pane = (await panes.panes("duty"))[0]!;
    expect(await panes.pid(pane, ["cli.ts", "duty"], "bun")).toMatchObject({ kind: "unknown" });

    w.tree = [{ pid: 32, parent: 101, exe: "bun" }];
    w.foreground.set("w1:p1", [{ name: "bun", argv: ["bun", "cli.ts", "duty"], pid: 32 }]);
    expect(await panes.pid(pane, ["cli.ts", "duty"], "bun")).toEqual({ kind: "running", pid: 32 });
  });

  test("a named foreground beside another bun child is doubt, not the unit", async () => {
    const w = world();
    w.workspaces.push({ workspace_id: "w1", label: "dori-ops" });
    w.panes.push({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "duty" });
    w.shells.set("w1:p1", 101);
    w.tree = [
      { pid: 31, parent: 101, exe: "bun" },
      { pid: 33, parent: 101, exe: "bun" },
    ];
    w.foreground.set("w1:p1", [{ name: "bun", argv: ["bun", "cli.ts", "duty"], pid: 31 }]);
    const panes = adapter(w);
    await panes.ready();
    expect(await panes.pid((await panes.panes("duty"))[0]!, ["cli.ts", "duty"])).toMatchObject({ kind: "unknown" });
  });

  test("every unit starting at once shares one ops workspace", async () => {
    const w = world();
    const panes = adapter(w);
    await Promise.all(Array.from({ length: 6 }, () => panes.ready()));
    expect(w.calls.filter((c) => c[0] === "workspace" && c[1] === "create")).toHaveLength(1);
  });
});
