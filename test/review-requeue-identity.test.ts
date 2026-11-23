import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { readJson, writeJson } from "../src/json-file.ts";
import { ready, startLane } from "../src/lanes.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { HOSTNAME, processStartTime } from "../src/process-identity.ts";
import { clearRun, finishJob, jobPath, liveRun, reviewerIdentity, runPath, writeRun } from "../src/review-job.ts";
import { queueLaneReview } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

async function world() {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  await startLane(s.d, "fix-login", s.brief, { group: "w1" });
  await ready(s.d, "fix-login", "fixed", ["file:///fix-login"]);
  repo.head = tip;
  return s;
}

async function withWorker<R>(d: Deps, run: () => Promise<R>): Promise<R> {
  const held = acquire(d, d.store.lockPath("duty"));
  if ("holder" in held) throw new Error(held.holder);
  try {
    return await run();
  } finally {
    release(d, held.nonce, d.store.lockPath("duty"));
  }
}

async function sleeperProcess(d: Deps) {
  const file = join(d.store.root, "sleeper.ts");
  writeFileSync(file, "await Bun.sleep(60_000);\n");
  return Bun.spawn([process.execPath, file], { detached: true, stdout: "ignore", stderr: "ignore" });
}

describe("recorded reviewer identity", () => {
  test("a stale marker naming a live unrelated pid is dropped without killing it", async () => {
    const { w, d } = await world();
    const sleeper = await sleeperProcess(d);
    const marker = runPath(d.store.root, "fix-login", tip);
    const stillAlive = (): boolean => {
      try {
        process.kill(sleeper.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));
      writeFileSync(marker, JSON.stringify({ requestedAt: w.clock, pid: sleeper.pid }));
      w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
      expect(await dutyTick(d)).toEqual([{ lane: "fix-login", action: "review-done", detail: `CLEAR at ${tip}` }]);
      expect(stillAlive()).toBe(true);
      expect(existsSync(marker)).toBe(false);

      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));
      const start = processStartTime(sleeper.pid);
      writeFileSync(
        marker,
        JSON.stringify({
          requestedAt: w.clock,
          pid: sleeper.pid,
          host: HOSTNAME,
          startTime: start === null ? null : start + 1,
        }),
      );
      expect(await dutyTick(d)).toEqual([{ lane: "fix-login", action: "review-done", detail: `CLEAR at ${tip}` }]);
      expect(stillAlive()).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("a marker still naming a verified live reviewer survives clearRun until that process is gone", async () => {
    const { d } = await world();
    const sleeper = await sleeperProcess(d);
    try {
      writeRun(d.store.root, "fix-login", tip, {
        requestedAt: 42,
        pid: sleeper.pid,
        ...reviewerIdentity(sleeper.pid),
      });
      expect(clearRun(d.store.root, "fix-login", tip, 42)).toBe(false);
      expect(liveRun(d.store.root, "fix-login", tip, 42)).toBe(true);
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(true);
      sleeper.kill();
      await sleeper.exited;
      expect(liveRun(d.store.root, "fix-login", tip, 42)).toBe(false);
      expect(clearRun(d.store.root, "fix-login", tip, 42)).toBe(true);
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(false);
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("a finished drain cannot delete a job a restart wrote at the same path", () => {
    const { d } = setup();
    const path = jobPath(d.store.root, "fix-login", tip);
    mkdirSync(join(d.store.root, "state", "review-queue"), { recursive: true });
    const record = (requestedAt: number) => ({
      lane: "fix-login",
      tip,
      base,
      requestedAt,
      state: "queued" as const,
    });
    writeJson(path, record(1000));
    writeJson(path, record(1001));
    expect(finishJob(path, 1000)).toBe(false);
    expect(readJson<{ requestedAt: number }>(path)).toMatchObject({ requestedAt: 1001 });
    expect(finishJob(path, 1001)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(finishJob(path, 1001)).toBe(false);
  });
});
