import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";
import { pidAlive, processStartTimeMs, terminateProcess } from "../src/process-liveness.ts";
import { writePluginRecord } from "../src/plugins/state.ts";
import {
  claimSupervisor,
  ensureSupervisors,
  killSupervisorTree,
  recordedAlive,
  recordedChildren,
} from "../src/supervisor-run.ts";
import { NOW, homeWithState } from "./supervisor-fixtures.ts";

const recordedTree = () => {
  const home = homeWithState();
  writeSupervisorRecord(home, {
    name: "supervisor",
    pid: 4242,
    startedAt: NOW,
    units: [{ name: "duty", pid: 4343, at: NOW, pane: "w1:p2" }],
    at: NOW,
  });
  writeSupervisorRecord(home, { name: "watchdog", pid: 4646, startedAt: NOW, units: [], at: NOW });
  writePluginRecord(home, { name: "ensure-up", pid: 4444, startedAt: NOW, at: NOW });
  writeEnsureUpRecord(home, { pid: 4545, startedAt: NOW, at: NOW });
  return home;
};

describe("record-based restarts", () => {
  test("the record's supervisor, unit, plugin and ensure-up pids are the whole kill list", async () => {
    const home = recordedTree();
    const killed: number[] = [];
    const result = await killSupervisorTree(home, {
      alive: () => true,
      kill: (pid) => {
        killed.push(pid);
        return true;
      },
    });
    expect(result).toEqual([4242, 4343, 4444, 4545]);
    expect(killed).toEqual([4242, 4343, 4444, 4545]);
  });

  test("a pid the record cannot prove alive is left alone", async () => {
    const home = recordedTree();
    const killed: number[] = [];
    expect(
      await killSupervisorTree(home, {
        alive: (child) => child.pid === 4343,
        kill: (pid) => {
          killed.push(pid);
          return true;
        },
      }),
    ).toEqual([4343]);
    expect(killed).toEqual([4343]);
  });

  test("recordedChildren lists each child once", () => {
    const home = recordedTree();
    expect(
      recordedChildren(home)
        .map((c) => c.pid)
        .sort((a, b) => a - b),
    ).toEqual([4343, 4444, 4545]);
  });

  test("ensureSupervisors leaves a live recorded supervisor alone and starts a missing pair", async () => {
    const home = recordedTree();
    const spawned: string[] = [];
    await ensureSupervisors(home, 0, {
      alive: (pid) => pid === 4242 || pid === 4646,
      spawn: (entry) => {
        spawned.push(entry);
        return 1;
      },
    });
    expect(spawned).toEqual([]);

    const empty = homeWithState();
    await ensureSupervisors(empty, 0, {
      alive: () => false,
      spawn: (entry) => {
        spawned.push(entry);
        return 1;
      },
    });
    expect(spawned.map((entry) => entry.replaceAll("\\", "/").split("/").at(-1))).toEqual([
      "supervisor.ts",
      "watchdog.ts",
    ]);
  });
});

test("a live recorded supervisor with a fresh beat refuses a second claim", async () => {
  const home = homeWithState();
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  try {
    const startedAt = processStartTimeMs(child.pid) ?? Date.now();
    writeSupervisorRecord(home, { name: "supervisor", pid: child.pid, startedAt, units: [], at: Date.now() });
    writeFileSync(join(home, "state", "supervisor-heartbeat"), new Date().toISOString());
    expect(claimSupervisor(home, join(home, "state"))).toBe(`already_running pids=${child.pid}`);
  } finally {
    terminateProcess(child.pid);
    await child.exited;
  }
});

test("a stale recorded supervisor is taken over and its pid terminated", async () => {
  const home = homeWithState();
  const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const startedAt = processStartTimeMs(child.pid) ?? Date.now();
  writeSupervisorRecord(home, { name: "supervisor", pid: child.pid, startedAt, units: [], at: Date.now() });
  expect(claimSupervisor(home, join(home, "state"))).toBeUndefined();
  await child.exited;
  expect(pidAlive(child.pid)).toBe(false);
});

test("an unreadable start time is doubt, not a reused pid", () => {
  const child = { pid: process.ppid, at: Date.now() };
  expect(recordedAlive(child, { started: () => null })).toBe(true);
  expect(recordedAlive(child, { started: () => child.at + 60_000 })).toBe(false);
});
