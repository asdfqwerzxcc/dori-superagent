import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Proc } from "../src/lead-process-list.ts";
import { pidAlive, processStartTimeMs, terminateProcess } from "../src/process-liveness.ts";
import { ensureGateway, killPlan, supervisorEntries, supervisorPids } from "../src/supervisors/ensure-gateway.ts";
import { writeSupervisorRecord } from "../src/supervisors.ts";
import { NOW, beat, homeWithState } from "./supervisor-fixtures.ts";

const STALE = 10 * 60_000;
const PID_SET = new Set([4242, 4244, 4343, 999]);

const record = (home: string, pid: number, units: { name: string; pid: number }[] = []): void => {
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid,
    startedAt: NOW,
    units: units.map((u) => ({ ...u, at: NOW })),
    at: NOW,
  });
};

describe("kill plan", () => {
  const tree: readonly Proc[] = [
    { pid: 100, command: "bun supervisor.ts", parent: 1 },
    { pid: 101, command: "bun duty.ts", parent: 100 },
    { pid: 102, command: "bun session.ts", parent: 101 },
    { pid: 200, command: "bun unrelated.ts", parent: 1 },
  ];

  test("children come before parents, recorded units join at depth 1", () => {
    expect(killPlan([100], tree, [300], []).order).toEqual([102, 101, 300, 100]);
  });

  test("a protected supervisor root is not a root of the plan", () => {
    expect(killPlan([100], tree, [], [100]).order).toEqual([]);
    expect(killPlan([100], tree, [300], [101]).order).not.toContain(101);
  });

  test("the scan matches only the home shim and this checkout's program", () => {
    const home = homeWithState();
    const entries = supervisorEntries(home);
    const procs: readonly Proc[] = [
      { pid: 1, command: `bun ${entries[0]}`, parent: 0 },
      { pid: 2, command: `bun ${entries[1]}`, parent: 0 },
      { pid: 3, command: `bun ${join(home, "bin", "other.ts")}`, parent: 0 },
    ];
    expect(supervisorPids(procs, entries)).toEqual([1, 2]);
  });
});

describe("ensureGateway", () => {
  test("a fresh beat under a live record leaves everything alone and never scans", async () => {
    const home = homeWithState();
    record(home, 4242);
    beat(home, "supervisor-heartbeat", Date.now());
    const lines: string[] = [];
    const outcome = await ensureGateway(home, {
      procs: async () => {
        throw new Error("a healthy minute must not scan");
      },
      alive: () => true,
      recordedAlive: () => true,
      kill: () => {
        throw new Error("a healthy minute must not kill");
      },
      spawn: () => {
        throw new Error("a healthy minute must not spawn");
      },
      log: (line) => lines.push(line),
    });
    expect(outcome.action).toBe("healthy");
    expect(outcome.killed).toEqual([]);
    expect(lines).toEqual(["GUARD HEALTHY supervisor=4242 fresh=1"]);
  });

  test("a stale tree is logged before the kill, children first, and restart comes last", async () => {
    const home = homeWithState();
    record(home, 4242, [{ name: "duty", pid: 4343 }]);
    beat(home, "supervisor-heartbeat", Date.now() - STALE);
    const live = new Set(PID_SET);
    const events: string[] = [];
    const outcome = await ensureGateway(home, {
      procs: async () => [
        { pid: 4242, command: "bun supervisor.ts", parent: 1 },
        { pid: 4244, command: "bun gateway.ts", parent: 4242 },
        { pid: 4343, command: "bun duty.ts", parent: 900 },
        { pid: 999, command: "bun unrelated.ts", parent: 1 },
      ],
      alive: (pid) => live.has(pid),
      recordedAlive: (child) => child.pid === 4242 || child.pid === 4343,
      kill: (pid) => {
        events.push(`kill:${pid}`);
        live.delete(pid);
        return true;
      },
      spawn: () => {
        beat(home, "supervisor-heartbeat", Date.now());
        return 5000;
      },
      sleep: async () => {},
      log: (line) => events.push(`log:${line}`),
      killTries: 1,
      beatTries: 1,
    });

    expect(outcome.action).toBe("restarted");
    expect(outcome.killed).toEqual([4244, 4343, 4242]);
    expect(outcome.survivors).toEqual([]);
    expect(live.has(999)).toBe(true);
    const killLine = events.findIndex((e) => e.startsWith("log:GUARD KILL"));
    const firstKill = events.findIndex((e) => e.startsWith("kill:"));
    const survivors = events.findIndex((e) => e.startsWith("log:GUARD SURVIVORS pids=none"));
    expect(killLine).toBeGreaterThanOrEqual(0);
    expect(firstKill).toBeGreaterThan(killLine);
    expect(survivors).toBeGreaterThan(firstKill);
    expect(events[killLine]).toContain("tree=4244,4343,4242");
    expect(events.at(-1)).toBe("log:GUARD BEAT supervisor=5000 fresh=1");
  });

  test("a survivor refuses the restart instead of duplicating it", async () => {
    const home = homeWithState();
    record(home, 4242);
    beat(home, "supervisor-heartbeat", 0);
    let spawned = false;
    const outcome = await ensureGateway(home, {
      procs: async () => [],
      alive: () => true,
      recordedAlive: () => true,
      kill: () => true,
      spawn: () => {
        spawned = true;
        return 1;
      },
      sleep: async () => {},
      killTries: 1,
      beatTries: 1,
    });
    expect(outcome.action).toBe("refused");
    expect(outcome.survivors).toEqual([4242]);
    expect(spawned).toBe(false);
    expect(outcome.lines.some((l) => l.startsWith("GUARD START skipped=1 survivors=4242"))).toBe(true);
  });
});

const fakeSupervisor = (home: string): string => {
  const path = join(home, "bin", "supervisor.ts");
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    path,
    `import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env["DORI_HOME"] ?? "";
const pidFile = process.env["FAKE_CHILD_PID_FILE"];
if (pidFile) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(pidFile, String(child.pid));
  setTimeout(() => {}, 60000);
} else {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "supervisor-heartbeat"), new Date().toISOString());
}
`,
  );
  return path;
};
test("the real guard kills a live supervisor's unrecorded child and logs before and after", async () => {
  const home = homeWithState();
  const entry = fakeSupervisor(home);
  const pidFile = join(home, "child.pid");
  const parent = Bun.spawn([process.execPath, entry], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env, DORI_HOME: home, FAKE_CHILD_PID_FILE: pidFile },
  });
  let childPid = 0;
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    childPid = Number(readFileSync(pidFile, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    beat(home, "supervisor-heartbeat", Date.now() - STALE);
    writeSupervisorRecord(home, {
      name: "supervisor",
      pid: parent.pid,
      startedAt: processStartTimeMs(parent.pid) ?? Date.now(),
      units: [],
      at: Date.now(),
    });
    const guard = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "src", "supervisors", "ensure-gateway.ts")],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, DORI_HOME: home },
      },
    );
    const [code, stdout] = await Promise.all([guard.exited, new Response(guard.stdout).text()]);
    expect(code).toBe(0);
    const kill = stdout.split("\n").find((l) => l.startsWith("GUARD KILL")) ?? "";
    expect(kill).toContain(String(childPid));
    expect(kill).toContain(String(parent.pid));
    expect(stdout).toContain("GUARD SURVIVORS pids=none");
    const tree = kill.slice(kill.indexOf("tree="));
    expect(tree.indexOf(String(childPid))).toBeLessThan(tree.indexOf(String(parent.pid)));
    await parent.exited;
    expect(pidAlive(parent.pid)).toBe(false);
    for (let i = 0; i < 40 && pidAlive(childPid); i++) await Bun.sleep(50);
    expect(pidAlive(childPid)).toBe(false);
    const kept = readFileSync(join(home, "state", "ensure-gateway.log"), "utf8");
    expect(kept).toContain("GUARD KILL");
    expect(kept).toContain("GUARD SURVIVORS");
  } finally {
    terminateProcess(parent.pid);
    if (childPid > 0) terminateProcess(childPid);
    await parent.exited;
  }
}, 30_000);

test.skipIf(process.platform !== "win32")(
  "bin/ensure-gateway.ps1 runs the guard program and keeps its exit code",
  async () => {
    const home = homeWithState();
    const marker = join(home, "ran.txt");
    const guard = join(home, "fake-guard.ts");
    writeFileSync(
      guard,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ok");\nprocess.exit(3);\n`,
    );
    const ps = Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "..", "bin", "ensure-gateway.ps1"),
        "-Guard",
        guard,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, DORI_HOME: home } },
    );
    const [code, stderr] = await Promise.all([ps.exited, new Response(ps.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(3);
    expect(readFileSync(marker, "utf8")).toBe("ok");
  },
  30_000,
);
