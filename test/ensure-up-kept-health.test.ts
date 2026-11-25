import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTimeMs } from "../src/process-liveness.ts";
import { writePluginRecord } from "../src/plugins/state.ts";
import { superviseHome } from "../src/supervise-home.ts";
import { writeEnsureUpRecord, writeSupervisorRecord } from "../src/supervisors.ts";

const NOW = 1_800_000_000_000;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-kept-"));
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  return home;
};

describe("a kept ensure-up process", () => {
  test("is reported up while the old loop record still names the killed holder", async () => {
    const home = homeWithState();
    const start = processStartTimeMs(process.ppid) ?? Date.now();
    writeFileSync(
      join(home, "state", "plugins", "ensure-up.lock"),
      JSON.stringify({ version: 1, token: "kept", pid: process.ppid, at: NOW, startedAt: start }),
    );
    writePluginRecord(home, { name: "ensure-up", pid: process.ppid, startedAt: start, at: NOW });
    writeFileSync(join(home, "state", "plugins", "ensure-up.tick"), JSON.stringify({ pid: process.ppid, at: NOW }));
    writeEnsureUpRecord(home, { pid: 999_999, startedAt: NOW - 60_000, at: NOW - 60_000 });
    writeSupervisorRecord(home, {
      name: "supervisor",
      pid: process.ppid,
      startedAt: start,
      units: [{ name: "ensure-up", pid: process.ppid, at: NOW, startedAt: start }],
      at: NOW,
    });
    const lines: string[] = [];
    const state = await superviseHome(home, {
      startMissing: false,
      wait: async () => ({ alive: false }),
      log: (line) => lines.push(line),
      sleep: async () => {},
      now: () => NOW,
    });
    expect(state.ensureUp).toMatchObject({ pid: process.ppid, alive: true });
    expect(lines).toEqual([]);
  });
});
