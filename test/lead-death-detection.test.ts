import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { up } from "../src/cli-up.ts";
import { LEAD_STARTING_MS, leadStarting } from "../src/lead-starting.ts";
import type { ProcNode } from "../src/process-tree.ts";
import type { ExecResult } from "../src/runtime/exec.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { ensureUpCheck } from "../src/supervisors/ensure-up.ts";
import { World, href } from "./fake.ts";
import { ok, recorder, ref } from "./herdr-recorder.ts";
import { captureIo } from "./inbox-setup.ts";

// D2: on 2026-11-26 a lane killed every bun.exe on the host, the lead's TUI died, and herdr kept answering
// agent:"pi" agent_status:"working" for the pane. ensure-up and dori up read that word as a live lead for 90 minutes.

const PANE = "w1:p1";
const SHELL_PID = 500;
const PROMPT = "PS C:\\Users\\USER> ";

/** `pane get` gives herdr's word, `pane process-info` the pane's shell, and `pane read` a screen that is no idle box. */
const herdrPanes = (status: string, agent: string | null = "pi") =>
  recorder((argv): ExecResult => {
    if (argv[0] === "pane" && argv[1] === "get")
      return ok({ pane: { pane_id: PANE, ...(agent === null ? {} : { agent }), agent_status: status } });
    if (argv[0] === "pane" && argv[1] === "process-info")
      return ok({
        process_info: {
          pane_id: PANE,
          shell_pid: SHELL_PID,
          foreground_process_group_id: SHELL_PID,
          foreground_processes: [{ name: "powershell.exe", argv: ["powershell.exe"], pid: SHELL_PID }],
        },
      });
    if (argv[0] === "pane" && argv[1] === "read")
      return { code: 0, stdout: "── • Working (8s • esc to interrupt) ──\n❯\n", stderr: "" };
    return ok({});
  });

const runtimeOver = (reply: ReturnType<typeof herdrPanes>, tree: ProcNode[] | undefined) =>
  new HerdrRuntime(reply.exec, "", { tree: async () => tree });

const shell = (): ProcNode => ({ pid: SHELL_PID, exe: "powershell.exe" });
const tui = (): ProcNode => ({ pid: SHELL_PID + 1, parent: SHELL_PID, exe: "omo.exe" });

/** A start marker past its 3-minute grace but inside the 15-minute attempt window: a stale heartbeat. */
const staleGrace = (home: string): void => {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(
    join(home, "state", "lead-starting.json"),
    JSON.stringify({ attempts: 1, at: Date.now() - LEAD_STARTING_MS - 60_000 }),
  );
};

describe("a pane whose TUI exited is down, whatever herdr says", () => {
  test("dead TUI reporting working: shell, exited, no agent, and its screen is never read for a turn", async () => {
    const r = herdrPanes("working");
    const p = await runtimeOver(r, [shell()]).probe(ref(PANE));
    expect(p).toMatchObject({ status: "shell", liveness: "exited", shellInFront: true, rootPid: SHELL_PID });
    expect(p.agent).toBeUndefined();
    expect(r.calls.some((argv) => argv[1] === "read")).toBe(false);
  });

  test("a live TUI reporting working stays working: the pane shell has its agent as a child", async () => {
    const r = herdrPanes("working");
    const p = await runtimeOver(r, [shell(), tui()]).probe(ref(PANE));
    expect(p).toMatchObject({ status: "working", agent: "pi", liveness: "alive" });
  });

  test("a shell pane is a childless shell, and an unreadable snapshot is doubt, not the pane's death", async () => {
    const shellPane = await runtimeOver(herdrPanes("shell", null), [shell()]).probe(ref(PANE));
    expect(shellPane).toMatchObject({ status: "shell", liveness: "exited" });
    const doubt = await runtimeOver(herdrPanes("idle"), undefined).probe(ref(PANE));
    expect(doubt).toMatchObject({ status: "idle", agent: "pi", liveness: "doubt" });
  });

  test("delivery into a dead or unproven pane is refused, so the text never runs as a shell command", async () => {
    for (const tree of [[shell()], undefined]) {
      const r = herdrPanes("working");
      const dead = runtimeOver(r, tree);
      expect(await dead.deliver(ref(PANE), "rm -rf nothing")).toEqual({ kind: "no-agent" });
      expect(r.calls.some((argv) => argv[0] === "agent" || argv[1] === "send-text")).toBe(false);
    }
  });
});

describe("a stale heartbeat alone never revives the lead", () => {
  const worldOver = (tree: ProcNode[]) => {
    const w = new World();
    Object.assign(w.addPane(PANE, "working"), { shellPid: SHELL_PID, screen: PROMPT });
    w.tree = tree;
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    staleGrace(d.store.root);
    return { w, d };
  };

  test("ensure-up: herdr says working and the TUI is alive: alive, no dori up", async () => {
    const { w, d } = worldOver([shell(), tui()]);
    let calls = 0;
    const state = await ensureUpCheck({
      home: d.store.root,
      exec: d.exec,
      tree: w.treeProvider,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: () => {},
    });
    expect(state).toBe("alive");
    expect(calls).toBe(0);
  });

  test("ensure-up: the same stale heartbeat with the TUI gone is down and runs dori up once", async () => {
    const { w, d } = worldOver([shell()]);
    let calls = 0;
    const lines: string[] = [];
    const state = await ensureUpCheck({
      home: d.store.root,
      exec: d.exec,
      tree: w.treeProvider,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: () => {},
      report: (_s, line) => lines.push(line),
    });
    expect(state).toBe("down");
    expect(calls).toBe(1);
    expect(lines.join("\n")).toContain("ENSURE_UP lead pane has no agent");
  });
});

describe("ensure-up treats an unproven lead as down", () => {
  test("a dead TUI herdr still calls working, and an unreadable snapshot, both run dori up", async () => {
    const w = new World();
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    let calls = 0;
    const raise = async () => {
      calls += 1;
      return { code: 0, detail: "" };
    };
    const exec = herdrPanes("working").exec;
    expect(
      await ensureUpCheck({ home: d.store.root, exec, tree: async () => [shell()], up: raise, log: () => {} }),
    ).toBe("down");
    expect(calls).toBe(1);
    const lines: string[] = [];
    const doubt = await ensureUpCheck({
      home: d.store.root,
      exec,
      tree: async () => undefined,
      up: raise,
      log: () => {},
      sleep: async () => {},
      report: (_s, line) => lines.push(line),
    });
    expect(doubt).toBe("down");
    expect(calls).toBe(2);
    expect(lines.join("\n")).toContain("lead pane's process tree is unreadable");
  });
});

describe("the lead is revived in its own pane, and roles.json keeps the ref", () => {
  test("dori up on a dead TUI at an empty prompt starts the agent in the same pane", async () => {
    const w = new World();
    Object.assign(w.addPane(PANE, "working"), { shellPid: SHELL_PID, screen: PROMPT });
    w.tree = [shell()];
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain(`UP lead revived in ${PANE}`);
    expect(out).not.toContain("lead alive");
    expect(d.store.roles().lead).toEqual(href(PANE));
    const runs = w.calls.filter((c) => c.cmd === "herdr" && c.argv[0] === "pane" && c.argv[1] === "run");
    expect(runs.map((c) => c.argv[2])).toEqual([PANE]);
    expect(runs[0]?.argv[3]).toContain("lead.md");
    expect(w.calls.some((c) => c.cmd === "herdr" && c.argv[1] === "create")).toBe(false);
    // The grace makes the next tick say "starting" instead of typing a second lead into the same pane.
    expect(leadStarting(d.store.root).starting).toBe(true);
  });

  test("ensure-up finds the dead lead, dori up revives it in place, and the ref never moves", async () => {
    const w = new World();
    Object.assign(w.addPane(PANE, "working"), { shellPid: SHELL_PID, screen: PROMPT });
    w.tree = [shell()];
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    const state = await ensureUpCheck({
      home: d.store.root,
      exec: d.exec,
      tree: w.treeProvider,
      up: async () => {
        const { out } = await captureIo(async () => {
          await up(d, "/w");
          return 0;
        });
        return { code: 0, detail: out.split("\n")[0] ?? "" };
      },
      log: () => {},
    });
    expect(state).toBe("down");
    expect(d.store.roles().lead).toEqual(href(PANE));
    expect(w.panes.get(PANE)?.ran).toHaveLength(1);
  });

  test("a bare shell proven at its prompt is revived in the same pane too", async () => {
    const w = new World();
    Object.assign(w.addPane(PANE, "shell"), { shellPid: SHELL_PID, screen: PROMPT });
    w.tree = [shell()];
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(out).toContain(`UP lead revived in ${PANE}`);
    expect(d.store.roles().lead).toEqual(href(PANE));
    expect(w.panes.get(PANE)?.ran).toHaveLength(1);
  });

  test("a pane that still runs something is not typed into: a new lead replaces it, as before", async () => {
    const w = new World();
    Object.assign(w.addPane(PANE, "shell"), { shellPid: SHELL_PID, screen: PROMPT });
    w.tree = [shell(), { pid: SHELL_PID + 2, parent: SHELL_PID, exe: "node.exe" }];
    const d = w.deps();
    d.store.setRole("lead", href(PANE));
    const { out } = await captureIo(async () => {
      await up(d, "/w");
      return 0;
    });
    expect(w.panes.get(PANE)?.ran).toEqual([]);
    expect(out).toContain("UP runtime=herdr lead=w1:p2");
    expect(d.store.roles().lead).toEqual(href("w1:p2"));
  });
});
