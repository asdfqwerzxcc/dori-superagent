import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/runtime/exec.ts";
import { ensureUpStopped, runEnsureUp, workspaceAlive } from "../src/supervisors/ensure-up.ts";
import { ensureUpOff } from "../src/supervisors.ts";

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-ensure-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const herdrWith = (workspaces: { workspace_id: string; label?: string }[], panes: Record<string, unknown>[]): Exec => {
  return async (cmd, argv) => {
    if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
    if (argv[0] === "workspace") return { code: 0, stdout: JSON.stringify({ result: { workspaces } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
  };
};

const ALIVE = herdrWith(
  [{ workspace_id: "w9", label: "dori" }],
  [
    { workspace_id: "w9", agent: "pi", agent_status: "idle" },
    { workspace_id: "w9", agent: "pi", agent_status: "working" },
  ],
);
const DEAD = herdrWith([], []);
const HALF = herdrWith(
  [{ workspace_id: "w9", label: "dori" }],
  [{ workspace_id: "w9", agent: "pi", agent_status: "idle" }],
);

describe("ensure-up decisions", () => {
  test("two agent panes in a dori workspace is up; one pane or no workspace is down", async () => {
    expect(await workspaceAlive(ALIVE)).toBe(true);
    expect(await workspaceAlive(HALF)).toBe(false);
    expect(await workspaceAlive(DEAD)).toBe(false);
  });

  test("a down workspace runs dori up once and leaves a record plus a heartbeat", async () => {
    const home = homeWithState();
    let calls = 0;
    const code = await runEnsureUp({
      home,
      once: true,
      exec: DEAD,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "UP runtime=herdr lead=w9:p1" };
      },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    const record = JSON.parse(readFileSync(join(home, "state", "ensure-up.json"), "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(existsSync(join(home, "state", "ensure-up-heartbeat"))).toBe(true);
    expect(existsSync(join(home, "state", "ensure-up.lock"))).toBe(false);
  });

  test("an up workspace, or ensure-up.off, never runs dori up", async () => {
    for (const exec of [ALIVE]) {
      const home = homeWithState();
      let calls = 0;
      await runEnsureUp({
        home,
        once: true,
        exec,
        up: async () => {
          calls += 1;
          return { code: 0, detail: "" };
        },
        log: () => {},
      });
      expect(calls).toBe(0);
    }
    const home = homeWithState();
    writeFileSync(join(home, "state", "ensure-up.off"), "");
    let calls = 0;
    expect(ensureUpStopped(home)).toBe(true);
    expect(ensureUpOff(home)).toBe(true);
    await runEnsureUp({
      home,
      once: true,
      exec: DEAD,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: () => {},
    });
    expect(calls).toBe(0);
  });

  test("a lock held by another live process keeps a second loop from raising a second workspace", async () => {
    const home = homeWithState();
    writeFileSync(join(home, "state", "ensure-up.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    let calls = 0;
    const lines: string[] = [];
    await runEnsureUp({
      home,
      once: true,
      exec: DEAD,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: (l) => lines.push(l),
    });
    expect(calls).toBe(0);
    expect(lines.join("\n")).toContain("already running");
    expect(readFileSync(join(home, "state", "ensure-up.lock"), "utf8")).toContain(String(process.ppid));
  });
});
