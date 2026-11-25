import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ready } from "../src/lanes.ts";
import { HOUR, loopTick } from "../src/loop.ts";
import { HOSTNAME, pidAlive, processStartTime } from "../src/process-identity.ts";
import { queueDir, runPath } from "../src/review-job.ts";
import { setup } from "./loop-setup.ts";

const notices = (received: string[]) => received.filter((m) => m.startsWith("[HOLD"));

describe("loop holds", () => {
  test("a memory hold notifies once per consecutive reason with the numbers and the next try", async () => {
    const { w, d, lead, add } = setup();
    add("next");
    w.host = { load1: 0, cores: 8, memFreePct: 8, memFreeMb: 600 };

    const first = await loopTick(d, { force: true });
    expect(notices(lead.received)).toHaveLength(1);
    expect(notices(lead.received)[0]).toContain("mem free 8% (600 MB)");
    expect(notices(lead.received)[0]).toContain("1 item(s) waiting");
    expect(notices(lead.received)[0]).toContain(`next try ${new Date(w.clock + HOUR).toISOString().slice(0, 16)}Z`);
    expect(first.findings).toContain("hold notified: mem");
    expect(first.reclaimed?.join("\n")).toContain("memory reclaim: closed 0 landed lane(s)");
    expect(d.store.lastRun()?.findings).toContain("hold notified: mem");

    w.clock += HOUR;
    expect((await loopTick(d, { force: true })).findings).not.toContain("hold notified: mem");
    expect(notices(lead.received)).toHaveLength(1);

    w.host = { load1: 20, cores: 8, memFreePct: 50, memFreeMb: 4096 };
    w.clock += HOUR;
    const third = await loopTick(d, { force: true });
    expect(notices(lead.received)).toHaveLength(2);
    expect(notices(lead.received)[1]).toContain("load 20.0");
    expect(third.findings).toContain("hold notified: load");
  });

  test("a memory hold closes an idle landed lane session and retries the tick once memory recovers", async () => {
    const { w, d, lead, add } = setup();
    add("landed");
    add("next");
    await loopTick(d, { force: true, maxStarts: 1 });
    const lane = d.store.lane("landed")!;
    await ready(d, "landed", "PR up", ["https://github.com/acme/app/pull/9"]);
    w.panes.get(lane.paneId)!.status = "idle";
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ state: "MERGED" }) });
    const low = { load1: 0, cores: 8, memFreePct: 8, memFreeMb: 600 };
    const high = { load1: 0, cores: 8, memFreePct: 25, memFreeMb: 2000 };
    const recovered = { ...d, host: () => (w.panes.has(lane.paneId) ? low : high) };

    const run = await loopTick(recovered, { force: true, maxStarts: 2 });
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(run.started).toContain("next (p5)");
    const log = run.reclaimed?.join("\n") ?? "";
    expect(log).toContain("closed landed lane landed");
    expect(log).toContain("mem free 8% (600 MB) -> 25% (2000 MB)");
    expect(d.store.lastRun()?.reclaimed?.join("\n")).toContain("closed landed lane landed");
    expect(notices(lead.received)).toHaveLength(0);
  });

  test("a memory hold leaves an old review runner marker and its process alone", async () => {
    const { w, d, add } = setup();
    add("next");
    w.host = { load1: 0, cores: 8, memFreePct: 8, memFreeMb: 600 };
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) throw new Error("spawned review runner has no pid");
    try {
      const startTime = processStartTime(pid);
      expect(startTime).not.toBeNull();
      const sha = "a".repeat(40);
      const path = runPath(d.store.root, "reviewed", sha);
      mkdirSync(queueDir(d.store.root), { recursive: true });
      writeFileSync(path, JSON.stringify({ requestedAt: w.clock - 2 * HOUR, pid, host: HOSTNAME, startTime }));
      const run = await loopTick(d, { force: true });
      expect(existsSync(path)).toBe(true);
      expect(pidAlive(pid)).toBe(true);
      expect(run.reclaimed?.join("\n") ?? "").not.toContain("killed review runner");
      expect(run.reclaimed?.join("\n") ?? "").toContain("memory reclaim: closed 0 landed lane(s), failed 0");
    } finally {
      if (pidAlive(pid)) child.kill("SIGKILL");
    }
  });
});
