import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { ready, startLane } from "../src/lanes.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { reviewerIdentity, runPath } from "../src/review-job.ts";
import { reviewJobFor } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

async function world(keys: readonly string[] = ["fix-login"]) {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  for (const key of keys) {
    await startLane(s.d, key, s.brief, { group: "w1" });
    await ready(s.d, key, "fixed", [`file:///${key}`]);
  }
  repo.head = tip;
  return { ...s, repo };
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

const queue = (d: Deps, extra: readonly string[] = []) =>
  captureIo(() => main(["review", "--lane", "fix-login", ...extra], d));

describe("requeueing a lane review", () => {
  test("three in-flight requests return the same job and never a second reviewer", async () => {
    const { w, d } = await world();
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    let releaseReviewer!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseReviewer = resolve;
    });
    const reviewerCalls: (readonly string[])[] = [];
    w.reviewer = (argv, options) => {
      reviewerCalls.push(argv);
      options?.onSpawn?.({ kill: () => releaseReviewer() });
      spawned();
      return gate.then(() => ({ code: 143, stdout: "", stderr: "terminated" }));
    };

    const pass = withWorker(d, async () => {
      expect((await queue(d)).out).toBe(`QUEUED fix-login ${tip} fix-login@${tip}`);
      const drain = dutyTick(d);
      await started;
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ state: "running", requestedAt: w.clock });
      const line = `already queued fix-login@${tip} (running)`;
      expect([(await queue(d)).out, (await queue(d)).out, (await queue(d)).out]).toEqual([line, line, line]);
      expect(reviewerCalls).toHaveLength(1);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ requestedAt: w.clock });
      const records = readdirSync(join(d.store.root, "state", "review-queue")).filter((name) => name.endsWith(".json"));
      expect(records).toEqual([`fix-login@${tip}.json`]);
      releaseReviewer();
      return drain;
    });

    expect(await pass).toEqual([
      { lane: "fix-login", action: "review-failed", detail: expect.stringContaining("printed no output") },
    ]);
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
  });

  test("--restart kills the reviewer already running and queues a fresh job", async () => {
    const { w, d } = await world();
    const sleeperFile = join(d.store.root, "sleeper.ts");
    writeFileSync(sleeperFile, "await Bun.sleep(60_000);\n");
    const sleeper = Bun.spawn([process.execPath, sleeperFile], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    try {
      w.reviewer = async (_argv, options) => {
        options?.onSpawn?.({ pid: sleeper.pid, kill: () => {} });
        spawned();
        const code = await sleeper.exited;
        return { code: code ?? 1, stdout: "", stderr: "terminated" };
      };
      const pass = withWorker(d, async () => {
        expect((await queue(d)).out).toBe(`QUEUED fix-login ${tip} fix-login@${tip}`);
        const drain = dutyTick(d);
        await started;
        const before = reviewJobFor(d.store.root, "fix-login", tip);
        expect(before).toMatchObject({ state: "running", requestedAt: w.clock });

        expect(await queue(d, ["--restart"])).toEqual({
          code: 0,
          out: `QUEUED fix-login ${tip} fix-login@${tip} (restarted)`,
        });
        await sleeper.exited;
        expect(() => process.kill(sleeper.pid, 0)).toThrow();
        return drain;
      });
      expect(await pass).toEqual([{ lane: "fix-login", action: "review-cancelled" }]);

      const after = reviewJobFor(d.store.root, "fix-login", tip);
      expect(after).toMatchObject({ state: "queued", requestedAt: w.clock + 1 });

      w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
      expect(await withWorker(d, () => dutyTick(d))).toEqual([
        { lane: "fix-login", action: "review-done", detail: `CLEAR at ${tip}` },
      ]);
      expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(2);
      expect(d.store.laneReceipt("fix-login", tip)).toMatchObject({ verdict: "CLEAR" });
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });

  test("the inline path kills the reviewer a dead worker left and reviews alone", async () => {
    const { w, d } = await world();
    const sleeperFile = join(d.store.root, "sleeper.ts");
    writeFileSync(sleeperFile, "await Bun.sleep(60_000);\n");
    const sleeper = Bun.spawn([process.execPath, sleeperFile], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await withWorker(d, () => queue(d));
      writeFileSync(
        runPath(d.store.root, "fix-login", tip),
        JSON.stringify({ requestedAt: w.clock, pid: sleeper.pid, ...reviewerIdentity(sleeper.pid) }),
      );
      w.reviewer = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
      expect(await queue(d)).toEqual({ code: 0, out: `REVIEW_LANE fix-login tip=${tip} verdict=CLEAR` });
      await sleeper.exited;
      expect(() => process.kill(sleeper.pid, 0)).toThrow();
      expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(1);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
    } finally {
      try {
        sleeper.kill();
      } catch {}
    }
  });
});
