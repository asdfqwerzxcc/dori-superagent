import { describe, expect, test } from "bun:test";
import type { ProcNode } from "../src/process-tree.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { World, href } from "./fake.ts";

// D2 gate findings 3 and 4: every path that types into a pane — the operator's --to-shell and the inbox's late Enter —
// passes the same process-tree proof as the agent delivery, and an unreadable snapshot types nothing at all.

const PANE = "w1:p1";
const PROMPT = "PS C:\\Users\\USER> ";
const shell = (): ProcNode => ({ pid: 100, exe: "powershell.exe" });
const live = (): ProcNode[] => [shell(), { pid: 101, parent: 100, exe: "omo.exe" }];

const rtOver = (tree: ProcNode[] | undefined) => {
  const w = new World();
  w.tree = tree;
  return { w, rt: new HerdrRuntime(w.exec, "", { env: {}, sleep: async () => {}, tree: w.treeProvider }) };
};

describe("typeIntoShell types only at a childless shell whose bottom line is an empty prompt", () => {
  test("a proven prompt takes the text and Enter", async () => {
    const { w, rt } = rtOver([shell()]);
    const pane = w.addPane(PANE, "shell");
    pane.screen = PROMPT;
    expect(await rt.typeIntoShell(href(PANE), "ls -la")).toBe(true);
    expect(pane.received).toEqual(["ls -la"]);
    expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[1] === "send-keys").length).toBe(1);
  });

  test("a draft, a live child or an unreadable snapshot types nothing", async () => {
    for (const [tree, screen] of [
      [[shell()], `${PROMPT}rm -rf /`],
      [live(), PROMPT],
      [undefined, PROMPT],
    ] as const) {
      const { w, rt } = rtOver(tree as ProcNode[] | undefined);
      const pane = w.addPane(PANE, "shell");
      pane.screen = screen;
      expect(await rt.typeIntoShell(href(PANE), "ls")).toBe(false);
      expect(pane.received).toEqual([]);
      expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[1] === "send-text")).toEqual([]);
    }
  });

  test("a pane read that fails gets nothing typed", async () => {
    const { w, rt } = rtOver([shell()]);
    w.addPane(PANE, "shell").screen = undefined;
    expect(await rt.typeIntoShell(href(PANE), "ls")).toBe(false);
  });
});

describe("submitTyped presses Enter only where the agent is proven alive", () => {
  test("a dead pane is changed and an unreadable one waits; neither gets an Enter", async () => {
    for (const [tree, want] of [
      [[shell()], "changed"],
      [undefined, "wait"],
    ] as const) {
      const { w, rt } = rtOver(tree as ProcNode[] | undefined);
      w.addPane(PANE, "idle");
      expect(await rt.submitTyped(href(PANE), { agent: "pi", pgid: 101 })).toBe(want);
      expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[1] === "send-keys")).toEqual([]);
    }
  });

  test("a live pane still gets exactly one Enter", async () => {
    const { w, rt } = rtOver(live());
    Object.assign(w.addPane(PANE, "idle"), { pgid: 777 });
    expect(await rt.submitTyped(href(PANE), { agent: "pi", pgid: 777 })).toBe("submitted");
    expect(w.calls.filter((c) => c.cmd === "herdr" && c.argv[1] === "send-keys")).toHaveLength(1);
  });
});
