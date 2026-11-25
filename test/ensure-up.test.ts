import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/runtime/exec.ts";
import {
  ensureUpCheck,
  ensureUpStopped,
  leadRef,
  leadStatus,
  runEnsureUp,
  type EnsureUpState,
} from "../src/supervisors/ensure-up.ts";
import { ensureUpOff } from "../src/supervisors.ts";

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-ensure-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

/** `pane get` answers only for the panes given; `pane process-info` reports a live agent in front of every one. */
const herdrPanes = (panes: Readonly<Record<string, string>>): Exec => {
  return async (cmd, argv) => {
    if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unexpected ${cmd}` };
    if (argv[0] === "pane" && argv[1] === "get") {
      const status = panes[argv[2] ?? ""];
      if (status === undefined) return { code: 1, stdout: "", stderr: `pane_not_found ${argv[2]}` };
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            pane: {
              pane_id: argv[2],
              agent: status === "shell" ? null : "pi",
              agent_status: status,
            },
          },
        }),
        stderr: "",
      };
    }
    if (argv[0] === "pane" && argv[1] === "process-info") {
      return {
        code: 0,
        stdout: JSON.stringify({
          result: {
            process_info: {
              shell_pid: 100,
              foreground_process_group_id: 101,
              foreground_processes: [{ name: "omo", argv: ["omo"], pid: 101 }],
            },
          },
        }),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unhandled ${argv.join(" ")}` };
  };
};

const LEAD = herdrPanes({ "w9:p1": "idle" });
const LEAD_SHELL = herdrPanes({ "w9:p1": "shell" });
const LEAD_GONE = herdrPanes({});

/** A home whose roles.json names a lead, as `dori up` writes it. */
const homeWithLead = (ref: string): string => {
  const home = homeWithState();
  writeFileSync(join(home, "roles.json"), JSON.stringify({ lead: ref }));
  return home;
};

describe("ensure-up decisions", () => {
  test("the registered lead's own pane decides: one live lead is up, a gone pane or no role is down", async () => {
    const home = homeWithLead("w9:p1");
    expect(leadRef(home)).toEqual({ runtime: "herdr", id: "w9:p1" });
    expect(await leadStatus(home, LEAD)).toBe("idle");
    expect(await leadStatus(home, LEAD_SHELL)).toBe("shell");
    expect(await leadStatus(home, LEAD_GONE)).toBe("gone");
    expect(await leadStatus(homeWithState(), LEAD)).toBe("absent");
  });

  test("a lead pane that is only a shell is down and runs dori up once", async () => {
    const home = homeWithLead("w9:p1");
    let calls = 0;
    const states: EnsureUpState[] = [];
    const state = await ensureUpCheck({
      home,
      exec: LEAD_SHELL,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "UP runtime=herdr lead=w9:p2" };
      },
      log: () => {},
      report: (s) => states.push(s),
    });
    expect(state).toBe("down");
    expect(calls).toBe(1);
    expect(states).toEqual(["down"]);
  });

  test("a live lead alone is alive and raises nothing", async () => {
    const home = homeWithLead("w9:p1");
    let calls = 0;
    const states: EnsureUpState[] = [];
    const state = await ensureUpCheck({
      home,
      exec: LEAD,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "UP runtime=herdr lead=w9:p2" };
      },
      log: () => {},
      report: (s) => states.push(s),
    });
    expect(state).toBe("alive");
    expect(states).toEqual(["alive"]);
    expect(calls).toBe(0);
  });

  test("a gone lead pane is down and runs dori up once", async () => {
    const home = homeWithLead("w9:p1");
    let calls = 0;
    const state = await ensureUpCheck({
      home,
      exec: LEAD_GONE,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "UP runtime=herdr lead=w9:p2" };
      },
      log: () => {},
    });
    expect(state).toBe("down");
    expect(calls).toBe(1);
  });

  test("a down home runs dori up once and leaves a record plus a heartbeat", async () => {
    const home = homeWithState();
    let calls = 0;
    const code = await runEnsureUp({
      home,
      once: true,
      exec: LEAD_GONE,
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

  test("a live lead, or ensure-up.off, never runs dori up", async () => {
    const home = homeWithLead("w9:p1");
    let calls = 0;
    await runEnsureUp({
      home,
      once: true,
      exec: LEAD,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: () => {},
    });
    expect(calls).toBe(0);
    const stopped = homeWithState();
    writeFileSync(join(stopped, "state", "ensure-up.off"), "");
    expect(ensureUpStopped(stopped)).toBe(true);
    expect(ensureUpOff(stopped)).toBe(true);
    await runEnsureUp({
      home: stopped,
      once: true,
      exec: LEAD_GONE,
      up: async () => {
        calls += 1;
        return { code: 0, detail: "" };
      },
      log: () => {},
    });
    expect(calls).toBe(0);
  });

  test("a lock held by another live process keeps a second loop from opening a second lead", async () => {
    const home = homeWithState();
    writeFileSync(join(home, "state", "ensure-up.lock"), JSON.stringify({ pid: process.ppid, at: Date.now() }));
    let calls = 0;
    const lines: string[] = [];
    await runEnsureUp({
      home,
      once: true,
      exec: LEAD_GONE,
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
