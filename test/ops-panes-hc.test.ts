import { describe, expect, test } from "bun:test";
import { parseProbe } from "../src/runtime/hc/probe.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { PaneUnits } from "../src/supervisors/pane-units.ts";
import { PaneUnknown } from "../src/supervisors/panes.ts";
import { HcPanes } from "../src/supervisors/panes-hc.ts";
import { FakeHc, type FakeTerminal, terminal } from "./fake-hc.ts";
import { duty } from "./ops-panes-herdr-fixture.ts";

const REF: SessionRef = { runtime: "hc", id: "t1", group: "dori-ops" };

function panes(hc: FakeHc): HcPanes {
  return new HcPanes({
    home: "/home/dori",
    env: { DORI_HOME: "/home/dori" },
    // The terminal shell otherwise follows the host's $SHELL, which differs per CI platform.
    shell: "sh",
    exec: hc.exec,
    sleep: async () => {},
    log: () => {},
  });
}

const withForeground = (foreground: FakeTerminal["foreground"]): FakeHc =>
  new FakeHc({ t1: terminal({ labels: { "dori.group": "dori-ops", "dori.unit": "duty" }, foreground }) });

describe("hc unit panes", () => {
  test("a unit terminal is labelled, named, started, found and torn down", async () => {
    const hc = new FakeHc();
    const adapter = panes(hc);
    await adapter.ready();
    expect(hc.calls[0]).toEqual(["ls", "--label", "dori.group=dori-ops"]);
    const pane = await adapter.open("duty");
    expect(pane).toEqual({ runtime: "hc", id: "t1", group: "dori-ops" });
    const run = hc.calls.find((c) => c[0] === "run")!;
    expect(run).toContain("dori.group=dori-ops");
    expect(run).toContain("dori.unit=duty");
    expect(run).toContain("--name");
    expect(run.at(-1)).toBe("sh");
    await adapter.start(pane, "run duty");
    expect(hc.sent).toEqual([{ id: "t1", text: "run duty" }]);
    const record = hc.terminals.get(pane.id)!;
    record.foreground = { name: "bun", argv: ["bun", "cli.ts", "duty"], pid: 4_242 };
    expect(await adapter.pid(pane, ["cli.ts", "duty"])).toEqual({ kind: "running", pid: 4_242 });
    expect(await adapter.panes("duty")).toEqual([pane]);
    await adapter.close(pane);
    expect(hc.terminals.has("t1")).toBe(false);
  });
});

describe("the hc probe matches pid and command", () => {
  test("a foreground command line naming the unit is its pid", async () => {
    const hc = withForeground({ name: "bun", argv: ["bun", "cli.ts", "duty"], pid: 5_001 });
    expect(await panes(hc).pid(REF, ["cli.ts", "duty"], "bun")).toEqual({ kind: "running", pid: 5_001 });
  });

  test("a foreign interpreter with the unit's script is not the unit", async () => {
    const hc = withForeground({ name: "node", argv: ["node", "cli.ts", "duty"], pid: 5_008 });
    expect(await panes(hc).pid(REF, ["cli.ts", "duty"], "C:/bun/bun.exe")).toMatchObject({
      kind: "unknown",
      pid: 5_008,
    });
  });

  test("an empty argv carries no command line to match, so it is doubt with its pid as a hint", async () => {
    const hc = withForeground({ name: "bun.exe", argv: [], pid: 5_002 });
    expect(await panes(hc).pid(REF, ["cli.ts", "duty"], "C:/bun/bun.exe")).toMatchObject({
      kind: "unknown",
      pid: 5_002,
    });
  });

  test("an omitted argv keeps the parser's name word and stays doubt", async () => {
    const raw = { state: "live", status: { state: "idle" }, foreground: { name: "bun", pid: 5_006 } };
    expect(parseProbe(raw).foreground?.[0]?.argv).toEqual(["bun"]);
    const hc = new FakeHc({
      t1: terminal({
        labels: { "dori.group": "dori-ops", "dori.unit": "duty" },
        foreground: { name: "bun", pid: 5_006 } as FakeTerminal["foreground"],
      }),
    });
    expect(await panes(hc).pid(REF, ["cli.ts", "duty"], "bun")).toMatchObject({ kind: "unknown", pid: 5_006 });
  });

  test("a foreign bun with one word of argv is doubt, never the unit", async () => {
    const hc = withForeground({ name: "bun", argv: ["bun"], pid: 5_007 });
    expect(await panes(hc).pid(REF, ["cli.ts", "duty"], "bun")).toMatchObject({ kind: "unknown", pid: 5_007 });
  });

  test("a foreign process with no argv is doubt, and placement never types over it", async () => {
    const hc = withForeground({ name: "top", argv: [], pid: 5_004 });
    const adapter = panes(hc);
    expect(await adapter.pid(REF, ["cli.ts", "duty"], "bun")).toMatchObject({ kind: "unknown" });
    const units = new PaneUnits({ adapter, log: () => {}, sleep: async () => {}, startWindowMs: 0 });
    const failure: unknown = await units.place(duty).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(hc.sent).toEqual([]);
  });

  test("a foreign one-word command is doubt, and placement never types over it", async () => {
    const hc = withForeground({ name: "top", argv: ["top"], pid: 5_003 });
    const adapter = panes(hc);
    expect(await adapter.pid(REF, ["cli.ts", "duty"])).toMatchObject({ kind: "unknown" });
    const units = new PaneUnits({ adapter, log: () => {}, sleep: async () => {}, startWindowMs: 0 });
    const failure: unknown = await units.place(duty).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PaneUnknown);
    expect(hc.sent).toEqual([]);
  });
});
