import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli.ts";
import { runLeadSwap } from "../src/lead-swap.ts";
import { buildLeadCommand } from "../src/lead-swap-target.ts";
import { World, href } from "./fake.ts";
import { captureStdout, engineLine, options, promptText, rowsFor, scratch } from "./lead-restart-setup.ts";

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
