import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli.ts";
import { runLeadSwap } from "../src/lead-swap.ts";
import type { LeadSwapPlan } from "../src/lead-swap-detach.ts";
import { buildLeadCommand } from "../src/lead-swap-target.ts";
import { World, href } from "./fake.ts";
import { captureStdout, engineLine, options, promptText, rowsFor, scratch, shellOnly } from "./lead-restart-setup.ts";

describe("dori lead-restart", () => {
  test("dry-run finds the ensure-up lead by the pane's process tree and kills nothing", async () => {
    const w = new World();
    const d = w.deps();
    const pane = w.addPane("w1:p1", "idle");
    pane.shellPid = 100;
    pane.cwd = "C:\\Users\\USER";
    d.store.setRole("lead", href("w1:p1"));
    const prompt = join(d.store.root, "prompts", "lead.md");
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, promptText);
    const session = join(d.store.root, "lead-session.jsonl");
    writeFileSync(session, '{"type":"session"}\n');
    const rows = rowsFor(prompt);
    w.reviewer = async (argv) => {
      if (argv[0] === "--version") return { code: 0, stdout: `${engineLine}\n`, stderr: "" };
      if (process.platform === "win32") {
        if (argv.some((a) => a.includes("Win32_Process"))) {
          const cim = rows.map((row) => ({
            ProcessId: row.pid,
            ParentProcessId: row.parent ?? 0,
            CommandLine: row.command,
          }));
          return { code: 0, stdout: JSON.stringify(cim), stderr: "" };
        }
      } else if (argv[0] === "-A") {
        return { code: 0, stdout: rows.map((r) => `${r.pid} ${r.parent ?? 0} ${r.command}`).join("\n"), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
    };
    const r = await captureStdout(() => main(["lead-restart", "--dry-run", "--session", session], d));
    expect(r.code).toBe(0);
    expect(r.out).toContain("LEADSWAP dry-run pane=w1:p1");
    expect(r.out).toContain("target=26976");
    expect(r.out).toContain("matched=26976,25176,2012,336");
    expect(r.out).toContain(`session=${session}`);
    expect(r.out).toContain(`engine=${engineLine}`);
    expect(r.out).toContain(`LEADSWAP command ${buildLeadCommand("omo", session, prompt, process.platform)}`);
    expect(r.out).not.toContain("duty.md");
    expect(w.calls.filter((c) => c.cmd === "taskkill")).toEqual([]);
    expect(
      w.calls.filter(
        (c) => c.cmd === "herdr" && c.argv[0] === "pane" && (c.argv[1] === "send-text" || c.argv[1] === "send-keys"),
      ),
    ).toEqual([]);
  });

  test("a swap running inside the lead tree delegates to an out-of-tree worker and kills nothing", async () => {
    const s = scratch();
    const rows = [
      ...rowsFor(s.prompt),
      { pid: 4000, command: `bun ${s.home}/bin/lead-restart.ts --session ${s.session}`, parent: 336 },
      { pid: 700, command: "cmd.exe /c worker-parent", parent: 100 },
      {
        pid: 6000,
        command: `bun cli.ts lead-restart --swap-worker --prompt ${s.prompt} --session ${s.session}`,
        parent: 700,
      },
    ];
    let killed = 0;
    let delegated: LeadSwapPlan | undefined;
    let goSawLog = false;
    const { opts, lines } = options({
      ...s,
      list: async () => rows,
      probe: async () => ({ status: "idle", shellInFront: false, rootPid: 100 }),
      kill: async () => {
        killed += 1;
      },
      delegate: async (plan) => {
        delegated = plan;
        return {
          pid: 9876,
          go: () => {
            goSawLog = lines.some((line) => line.startsWith("LEADSWAP delegated launcher=9876"));
          },
        };
      },
      selfPid: 4000,
      typeShell: async () => false,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    const out = lines.join("\n");
    expect(r.code).toBe(0);
    expect(r.outcome).toBe("delegated");
    expect(killed).toBe(0);
    expect(delegated?.session).toBe(s.session);
    expect(delegated?.prompt).toBe(s.prompt);
    expect(delegated?.target).toEqual([26976]);
    expect(delegated?.matched).toEqual([26976, 25176, 2012, 336]);
    expect(delegated?.matched).not.toContain(6000);
    expect(delegated?.target).not.toContain(6000);
    expect(delegated?.drainMs).toBe(0);
    expect(delegated?.force).toBe(true);
    expect(goSawLog).toBe(true);
    expect(lines[0]).toStartWith("LEADSWAP start pane=w1:p1 session=");
    expect(out).toContain("LEADSWAP delegated launcher=9876");
    expect(out).not.toContain("LEADSWAP delegated pid=9876");
    expect(out).not.toContain("LEADSWAP killed");
  });

  test("a swap launched from the lead's own pane delegates even when its parent chain was reparented", async () => {
    const s = scratch();
    const rows = [...rowsFor(s.prompt), { pid: 5000, command: "bun dori lead-restart", parent: 1 }];
    let delegated = 0;
    const { opts, lines } = options({
      ...s,
      list: async () => rows,
      probe: async () => ({ status: "idle", shellInFront: false, rootPid: 100 }),
      delegate: async () => {
        delegated += 1;
        return { pid: 1234, go: () => {} };
      },
      selfPid: 5000,
      selfInPane: true,
      typeShell: async () => false,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    expect(r.outcome).toBe("delegated");
    expect(delegated).toBe(1);
    expect(lines.join("\n")).toContain("LEADSWAP delegated launcher=1234");
  });

  test("a swap running outside the lead tree does not delegate", async () => {
    const s = scratch();
    const rows = [...rowsFor(s.prompt), { pid: 5000, command: "bun dori lead-restart", parent: 1 }];
    let delegated = 0;
    const { opts } = options({
      ...s,
      list: async () => rows,
      probe: async () => ({ status: "working", shellInFront: false, rootPid: 100 }),
      delegate: async () => {
        delegated += 1;
        return { pid: 1, go: () => {} };
      },
      selfPid: 5000,
      typeShell: async () => true,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    expect(delegated).toBe(0);
    expect(r.outcome).toBe("failed");
  });

  test("a worker's own argv is never a target and its start line is tagged", async () => {
    const s = scratch();
    const rows = [
      ...rowsFor(s.prompt),
      { pid: 700, command: "cmd.exe /c worker-parent", parent: 100 },
      {
        pid: 6000,
        command: `bun cli.ts lead-restart --swap-worker --prompt ${s.prompt} --session ${s.session}`,
        parent: 700,
      },
    ];
    const newRows = [
      ...rows.filter((p) => p.pid === 100),
      { pid: 9001, command: `bun "C:\\omo.js" --append-system-prompt "${s.prompt}"`, parent: 100 },
    ];
    const killed: number[] = [];
    let after = false;
    let typed = false;
    const { opts, lines } = options({
      ...s,
      list: async () => (after ? (typed ? newRows : shellOnly) : rows),
      probe: async () =>
        typed
          ? { status: "working", shellInFront: false, rootPid: 100 }
          : after
            ? { status: "shell", shellInFront: true, rootPid: 100 }
            : { status: "idle", shellInFront: false, rootPid: 100 },
      kill: async (pid) => {
        killed.push(pid);
        after = true;
      },
      typeShell: async () => {
        typed = true;
        return true;
      },
      selfPid: 6000,
      worker: true,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    expect(r.outcome).toBe("restarted");
    expect(killed).toEqual([26976]);
    expect(killed).not.toContain(6000);
    expect(r.target).toEqual([26976]);
    expect(lines[0]).toMatch(/worker=1 pid=\d+$/);
  });

  test("the start line is first even when the pane cannot be read", async () => {
    const s = scratch();
    const { opts, lines } = options({
      ...s,
      list: async () => rowsFor(s.prompt),
      probe: async () => {
        throw new Error("probe refused");
      },
      typeShell: async () => false,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    expect(r.code).toBe(1);
    expect(lines[0]).toStartWith("LEADSWAP start pane=w1:p1 session=");
    expect(lines[1]).toContain("LEADSWAP FAILED cannot read pane");
  });

  test("a pane that still has a live agent is never typed into", async () => {
    const s = scratch();
    const rows = rowsFor(s.prompt);
    let typed = 0;
    const { opts, lines } = options({
      ...s,
      list: async () => rows,
      probe: async () => ({ status: "working", shellInFront: false, rootPid: 100 }),
      kill: async () => {},
      typeShell: async () => {
        typed += 1;
        return true;
      },
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    const out = lines.join("\n");
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("failed");
    expect(typed).toBe(0);
    expect(out).toContain("live agent after the kill");
    expect(out).not.toContain("RESTARTED");
  });
});
