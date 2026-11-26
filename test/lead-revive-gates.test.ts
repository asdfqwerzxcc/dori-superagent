import { describe, expect, test } from "bun:test";
import { up } from "../src/cli-up.ts";
import { LEAD_REVIVE, leadRevives, reviveCommand } from "../src/lead-revive.ts";
import { clearLeadStarting } from "../src/lead-starting.ts";
import type { ProcNode } from "../src/process-tree.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

// The gate findings on the in-place revive: an empty prompt before typing, one revive per pane, a confirmed second
// snapshot, no typing on doubt, and the requested cwd + lead env carried into the revived command.

const PANE = "w1:p1";
const SHELL_PID = 500;
const PROMPT = "PS C:\\Users\\USER> ";

const shell = (): ProcNode => ({ pid: SHELL_PID, exe: "powershell.exe" });
const tui = (): ProcNode => ({ pid: SHELL_PID + 1, parent: SHELL_PID, exe: "omo.exe" });

/** A registered lead whose pane sits at `screen`, with the given process tree. */
function worldWith(tree: ProcNode[] | undefined, screen: string) {
  const w = new World();
  Object.assign(w.addPane(PANE, "working"), { shellPid: SHELL_PID, screen });
  w.tree = tree;
  const d = w.deps();
  d.store.setRole("lead", href(PANE));
  return { w, d };
}

const runsOn = (w: World, pane: string) =>
  w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "pane" && c.argv[1] === "run" && c.argv[2] === pane);

const runUp = (d: ReturnType<World["deps"]>) =>
  captureIo(async () => {
    await up(d, "/w");
    return 0;
  });

describe("the revive types only at a proven empty prompt", () => {
  for (const [name, screen] of [
    ["a draft typed after the prompt", `${PROMPT}git status`],
    ["a border redrawn over the prompt row", `${PROMPT}──────────────`],
    ["a screen that is not a prompt at all", "── • Working (8s • esc to interrupt) ──\n❯"],
  ] as const) {
    test(`${name} is never typed into: a new lead replaces it`, async () => {
      const { w, d } = worldWith([shell()], screen);
      const { out } = await runUp(d);
      expect(runsOn(w, PANE)).toEqual([]);
      expect(out).toContain("UP runtime=herdr lead=w1:p2");
      expect(d.store.roles().lead).toEqual(href("w1:p2"));
    });
  }

  test("an unreadable screen (pane read fails) is no proof either", async () => {
    const { w, d } = worldWith([shell()], "");
    w.panes.get(PANE)!.screen = undefined;
    const { out } = await runUp(d);
    expect(runsOn(w, PANE)).toEqual([]);
    expect(out).toContain("UP runtime=herdr lead=w1:p2");
  });
});

describe("one in-place revive per pane, then a new lead", () => {
  test("the second attempt opens a new lead instead of typing into the same shell again", async () => {
    const { w, d } = worldWith([shell()], PROMPT);
    const first = await runUp(d);
    expect(first.out).toContain(`UP lead revived in ${PANE}`);
    expect(leadRevives(d.store.root, PANE)).toBe(1);
    // The TUI died again in the same pane; a second command line there could compose onto the first one's line.
    clearLeadStarting(d.store.root);
    const second = await runUp(d);
    expect(second.out).toContain("UP runtime=herdr lead=w1:p2");
    expect(runsOn(w, PANE)).toHaveLength(1);
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
  });

  test("a different pane starts the count over", async () => {
    const { w, d } = worldWith([shell()], PROMPT);
    await runUp(d);
    expect(leadRevives(d.store.root, PANE)).toBe(1);
    expect(leadRevives(d.store.root, "w1:p9")).toBe(0);
    expect(w.calls.some((c) => c.argv.includes(LEAD_REVIVE))).toBe(false);
  });
});

describe("doubt is never typed into and never reported as a live lead", () => {
  test("an unreadable snapshot opens a new lead, with the reason on stdout", async () => {
    const { w, d } = worldWith(undefined, PROMPT);
    const { out } = await runUp(d);
    expect(out).toContain("UP lead unproven");
    expect(out).toContain("UP runtime=herdr lead=w1:p2");
    expect(runsOn(w, PANE)).toEqual([]);
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
  });
});

describe("the confirming second snapshot", () => {
  test("a child that appears during the 300 ms wait cancels the revive", async () => {
    const { w, d } = worldWith([shell()], PROMPT);
    w.onSleep = () => {
      w.tree = [shell(), tui()];
    };
    const { out } = await runUp(d);
    expect(w.sleeps).toEqual([300]);
    expect(runsOn(w, PANE)).toEqual([]);
    expect(out).toContain("UP runtime=herdr lead=w1:p2");
  });

  test("an empty prompt with the childless shell still there after the wait is revived", async () => {
    const { w, d } = worldWith([shell()], PROMPT);
    await runUp(d);
    expect(w.sleeps).toEqual([300]);
    expect(runsOn(w, PANE)).toHaveLength(1);
  });
});

describe("the revived command keeps the requested cwd and the lead env", () => {
  test("Windows: PowerShell Set-Location plus $env, then the agent command", () => {
    expect(reviveCommand("omo --x '/p/lead.md'", "C:\\work", "win32")).toBe(
      "Set-Location -LiteralPath 'C:\\work'; $env:OMO_TASK_DEFAULT_BACKGROUND = '1'; omo --x '/p/lead.md'",
    );
  });

  test("POSIX: cd into the requested cwd, then env, then the agent command", () => {
    expect(reviveCommand("omo --x '/p/lead.md'", "/work dir", "linux")).toBe(
      "cd '/work dir' && env OMO_TASK_DEFAULT_BACKGROUND=1 omo --x '/p/lead.md'",
    );
  });

  test("dori up passes exactly that command to pane run", async () => {
    const { w, d } = worldWith([shell()], PROMPT);
    await runUp(d);
    const command = String(runsOn(w, PANE)[0]?.argv[3] ?? "");
    expect(command).toContain(process.platform === "win32" ? "Set-Location -LiteralPath '/w'" : "cd '/w'");
    expect(command).toContain("OMO_TASK_DEFAULT_BACKGROUND");
    expect(command).toContain("lead.md");
  });
});
