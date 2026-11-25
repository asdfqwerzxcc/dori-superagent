import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeps } from "../src/harness.ts";
import { pidAlive, processStartTimeMs, terminateProcess } from "../src/process-liveness.ts";
import { writePluginRecord } from "../src/plugins/state.ts";
import { writeSupervisorRecord } from "../src/supervisors.ts";

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-log-"));
  mkdirSync(join(home, "state", "plugins", "ensure-up.contenders"), { recursive: true });
  return home;
};

describe("the real dori up supervisor seam", () => {
  test("a real duplicate kill prints through the CLI logger", async () => {
    const home = homeWithState();
    writeFileSync(join(home, "state", "ensure-up.off"), "");
    const supervisorStart = processStartTimeMs(process.ppid) ?? Date.now();
    writeSupervisorRecord(home, {
      name: "supervisor",
      pid: process.ppid,
      startedAt: supervisorStart,
      units: [{ name: "ensure-up", pid: process.ppid, at: Date.now(), startedAt: supervisorStart }],
      at: Date.now(),
    });
    writePluginRecord(home, { name: "ensure-up", pid: process.ppid, startedAt: supervisorStart, at: Date.now() });
    writeFileSync(
      join(home, "state", "plugins", "ensure-up.tick"),
      JSON.stringify({ pid: process.ppid, at: Date.now() }),
    );
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    try {
      const startedAt = processStartTimeMs(child.pid) ?? null;
      expect(startedAt).not.toBeNull();
      writeFileSync(
        join(home, "state", "plugins", "ensure-up.contenders", `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, at: startedAt }),
      );
      const lines: string[] = [];
      const deps = defaultDeps();
      if (deps.supervise === undefined) throw new Error("defaultDeps has no supervise seam");
      await deps.supervise(home, { startMissing: false, log: (line) => lines.push(line) });
      expect(lines).toContain(`ENSURE_UP dedupe kept=${process.ppid} killed=${child.pid}`);
      await child.exited;
      expect(pidAlive(child.pid)).toBe(false);
    } finally {
      terminateProcess(child.pid);
      await child.exited;
    }
  });
});
