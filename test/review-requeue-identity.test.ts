import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { readJson, writeJson } from "../src/json-file.ts";
import { ready, startLane } from "../src/lanes.ts";
import { HOSTNAME, processStartTime } from "../src/process-identity.ts";
import { finishJob, jobPath, reviewJobFor, runPath } from "../src/review-job.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

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

const queue = (d: Deps, extra: readonly string[] = []) =>
  captureIo(() => main(["review", "--lane", "fix-login", ...extra], d));

async function sleeperProcess(d: Deps) {
  const file = join(d.store.root, "sleeper.ts");
  writeFileSync(file, "await Bun.sleep(60_000);\n");
  return Bun.spawn([process.execPath, file], { detached: true, stdout: "ignore", stderr: "ignore", windowsHide: true });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function marker(d: Deps, requestedAt: number, pid: number, startTime: number | null): void {
  writeFileSync(
    runPath(d.store.root, "fix-login", tip),
    JSON.stringify({ requestedAt, pid, host: HOSTNAME, startTime }),
  );
}

describe("legacy reviewer cleanup", () => {
  test("the default --restart replaces the request and leaves a recorded reviewer alone", async () => {
    const { w, d } = await world();
    const sleeper = await sleeperProcess(d);
    try {
      await queue(d);
      const job = reviewJobFor(d.store.root, "fix-login", tip);
      if (job === undefined || job === "corrupt") throw new Error("the request was not queued");
      marker(d, job.requestedAt, sleeper.pid, processStartTime(sleeper.pid));
      w.clock += 1_000;
      expect((await queue(d, ["--restart"])).out).toBe(`QUEUED fix-login ${tip} fix-login@${tip} (restarted)`);
      expect(alive(sleeper.pid)).toBe(true);
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(true);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ requestedAt: w.clock });
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("--legacy-kill kills the verified reviewer a marker records", async () => {
    const { d } = await world();
    const sleeper = await sleeperProcess(d);
    try {
      await queue(d);
      const job = reviewJobFor(d.store.root, "fix-login", tip);
      if (job === undefined || job === "corrupt") throw new Error("the request was not queued");
      const startTime = processStartTime(sleeper.pid);
      expect(startTime).not.toBeNull();
      marker(d, job.requestedAt, sleeper.pid, startTime);
      expect((await queue(d, ["--restart", "--legacy-kill"])).out).toContain("(restarted)");
      await sleeper.exited;
      expect(() => process.kill(sleeper.pid, 0)).toThrow();
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(false);
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("a marker whose start time does not match is dropped without killing that pid", async () => {
    const { d } = await world();
    const sleeper = await sleeperProcess(d);
    try {
      await queue(d);
      const job = reviewJobFor(d.store.root, "fix-login", tip);
      if (job === undefined || job === "corrupt") throw new Error("the request was not queued");
      marker(d, job.requestedAt, sleeper.pid, (processStartTime(sleeper.pid) ?? 0) + 1);
      expect((await queue(d, ["--restart", "--legacy-kill"])).out).toContain("(restarted)");
      expect(alive(sleeper.pid)).toBe(true);
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(false);
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("a finished attestation cannot delete a request a restart wrote at the same path", () => {
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
