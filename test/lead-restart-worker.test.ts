import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { leadRestart } from "../src/cli-lead-restart.ts";
import { runLeadSwap } from "../src/lead-swap.ts";
import { World } from "./fake.ts";
import { captureStdout, engineLine, options, promptText, rowsFor, scratch, shellOnly } from "./lead-restart-setup.ts";

describe("dori lead-restart worker", () => {
  test("a failed out-of-tree launch kills nothing", async () => {
    const s = scratch();
    const rows = [...rowsFor(s.prompt), { pid: 4000, command: "bun lead-restart", parent: 336 }];
    let killed = 0;
    const { opts, lines } = options({
      ...s,
      list: async () => rows,
      probe: async () => ({ status: "idle", shellInFront: false, rootPid: 100 }),
      kill: async () => {
        killed += 1;
      },
      delegate: async () => {
        throw new Error("wmi refused");
      },
      selfPid: 4000,
      typeShell: async () => false,
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    expect(r.code).toBe(1);
    expect(killed).toBe(0);
    expect(lines.join("\n")).toContain("could not start the out-of-tree swap: wmi refused");
  });

  test("--swap-worker never delegates, even from the lead pane", async () => {
    const w = new World();
    const d = w.deps();
    const pane = w.addPane("w1:p1", "idle");
    pane.shellPid = 100;
    pane.cwd = "C:\\Users\\USER";
    const prompt = join(d.store.root, "prompts", "lead.md");
    mkdirSync(dirname(prompt), { recursive: true });
    writeFileSync(prompt, promptText);
    const session = join(d.store.root, "worker-session.jsonl");
    writeFileSync(session, '{"type":"session"}\n');
    const previous = process.env["HERDR_PANE_ID"];
    process.env["HERDR_PANE_ID"] = "w1:p1";
    try {
      w.reviewer = async (argv) => {
        if (argv.some((a) => a.includes("Win32_Process"))) return { code: 0, stdout: "[]", stderr: "" };
        if (argv[0] === "--version") return { code: 0, stdout: `${engineLine}\n`, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };
      const a = parse(["lead-restart", "--swap-worker", "--pane", "w1:p1", "--session", session]);
      const r = await captureStdout(() => leadRestart(d, a, session));
      expect(r.code).toBe(1);
      expect(r.out).toContain("worker=1 pid=");
      expect(r.out).toContain("no lead process");
      expect(r.out).not.toContain("delegated");
      expect(w.calls.some((c) => c.cmd === "powershell" && c.argv.some((x) => x.includes("Invoke-CimMethod")))).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env["HERDR_PANE_ID"];
      else process.env["HERDR_PANE_ID"] = previous;
    }
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
});
