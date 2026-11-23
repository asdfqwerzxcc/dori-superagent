import { describe, expect, test } from "bun:test";
import { runLeadSwap } from "../src/lead-swap.ts";
import { buildLeadCommand } from "../src/lead-swap-target.ts";
import { engineLine, options, rowsFor, scratch, shellOnly } from "./lead-restart-setup.ts";

describe("dori lead-restart verification", () => {
  test("a bare shell gets the session and prompt relaunch line, and the new process is verified", async () => {
    const s = scratch();
    const oldRows = rowsFor(s.prompt);
    const newRows = [
      ...oldRows.filter((p) => p.pid === 100),
      {
        pid: 9001,
        command: `bun "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --append-system-prompt "${s.prompt}"`,
        parent: 100,
      },
    ];
    let killed = false;
    let launched = false;
    let typedText = "";
    const { opts, lines } = options({
      ...s,
      list: async () => (killed ? (launched ? newRows : shellOnly) : oldRows),
      probe: async () =>
        launched
          ? { status: "working", shellInFront: false, rootPid: 100 }
          : killed
            ? { status: "shell", shellInFront: true, rootPid: 100 }
            : { status: "idle", shellInFront: false, rootPid: 100 },
      kill: async () => {
        killed = true;
      },
      typeShell: async (text) => {
        typedText = text;
        launched = true;
        return true;
      },
      version: async () => engineLine,
    });
    const r = await runLeadSwap(opts);
    const out = lines.join("\n");
    expect(r.code).toBe(0);
    expect(r.outcome).toBe("restarted");
    expect(r.newPid).toBe(9001);
    expect(typedText).toBe(buildLeadCommand("omo", s.session, s.prompt, "win32"));
    expect(out).toContain("LEADSWAP RESTARTED pane=w1:p1 pid=9001");
    expect(out).toContain(`engine=${engineLine}`);
    expect(out).toContain("runtime=7e6f2769a7b6b23a");
  });

  test("an unreadable engine version is a failure, never a success", async () => {
    const s = scratch();
    const oldRows = rowsFor(s.prompt);
    const newRows = [
      ...oldRows.filter((p) => p.pid === 100),
      {
        pid: 9001,
        command: `bun "C:\\Users\\USER\\node_modules\\omo-ai\\bin\\omo.js" --append-system-prompt "${s.prompt}"`,
        parent: 100,
      },
    ];
    let killed = false;
    let launched = false;
    const { opts, lines } = options({
      ...s,
      list: async () => (killed ? (launched ? newRows : shellOnly) : oldRows),
      probe: async () =>
        killed && !launched
          ? { status: "shell", shellInFront: true, rootPid: 100 }
          : { status: "idle", shellInFront: false, rootPid: 100 },
      kill: async () => {
        killed = true;
      },
      typeShell: async () => {
        launched = true;
        return true;
      },
      version: async () => undefined,
    });
    const r = await runLeadSwap(opts);
    const out = lines.join("\n");
    expect(r.code).toBe(1);
    expect(r.outcome).toBe("failed");
    expect(out).toContain("engine version could not be read");
    expect(out).not.toContain("RESTARTED");
  });
});
