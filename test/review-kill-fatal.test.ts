import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { ready, startLane } from "../src/lanes.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { HOSTNAME } from "../src/process-identity.ts";
import { runPath } from "../src/review-job.ts";
import { killReviewTree } from "../src/review-kill.ts";
import { drainReviewQueue, queueLaneReview, reviewJobFor } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const section = (path: string, fill: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${fill}\n`;
const smallDiff = section("src/x.ts", "1");
const largeDiff = section("src/a.ts", "a".repeat(9_000)) + section("src/b.ts", "b".repeat(9_000));

async function world(diff: string) {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  await startLane(s.d, "fix-login", s.brief, { group: "w1" });
  await ready(s.d, "fix-login", "fixed", ["file:///fix-login"]);
  writeFileSync(join(s.d.store.root, "config.json"), JSON.stringify({ reviewFallbackModel: "fallback/model" }));
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

/** A real reviewer-shaped process pair: the parent names itself and starts a child, both sleeping. */
async function pair() {
  const dir = mkdtempSync(join(tmpdir(), "dori-kill-fatal-"));
  const sleeper = join(dir, "sleeper.ts");
  writeFileSync(sleeper, "await Bun.sleep(60_000);\n");
  const tree = join(dir, "tree.ts");
  writeFileSync(
    tree,
    `const child = Bun.spawn([process.execPath, ${JSON.stringify(sleeper)}], { stdout: "ignore", stderr: "ignore" });\n` +
      `console.log("PIDS " + process.pid + " " + child.pid);\n` +
      "await Bun.sleep(60_000);\n",
  );
  const proc = Bun.spawn([process.execPath, tree], { detached: true, stdout: "pipe", stderr: "ignore" });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the process pair exited before naming its pids");
    out += decoder.decode(value);
  }
  const match = /PIDS (\d+) (\d+)/.exec(out);
  if (match === null) throw new Error(`no pids in ${out}`);
  return { parent: Number(match[1]), child: Number(match[2]) };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const cleanup = (p: { parent: number; child: number }): void => {
  killReviewTree(p.parent);
  killReviewTree(p.child);
};

const failKill = () => ({ ok: false as const, why: "simulated kill refusal" });

describe("a failed reviewer-tree kill is fatal", () => {
  test("no fallback spawns, the job and marker stay, and the original pair is alive", async () => {
    const { w, d } = await world(smallDiff);
    const p = await pair();
    try {
      let calls = 0;
      w.reviewer = (_argv, options) => {
        calls++;
        options?.onSpawn?.({ pid: p.parent, kill: () => {} });
        return new Promise(() => {});
      };
      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));

      expect(await drainReviewQueue(d, { killTree: failKill, timeoutMs: 80 })).toEqual([
        {
          lane: "fix-login",
          action: "review-kill-failed",
          detail: "the reviewer tree is still alive; the job is kept for the next pass",
        },
      ]);
      expect(calls).toBe(1);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ state: "running" });
      const marker = JSON.parse(readFileSync(runPath(d.store.root, "fix-login", tip), "utf8"));
      expect(marker).toMatchObject({ pid: p.parent, host: HOSTNAME, startTime: expect.any(Number) });
      const receipt = d.store.laneReceipt("fix-login", tip);
      expect(receipt).toMatchObject({ verdict: "reviewer_timeout" });
      expect(receipt!.summary).toContain("could not be killed");
      expect(receipt!.summary).toContain("simulated kill refusal");
      expect(alive(p.parent)).toBe(true);
      expect(alive(p.child)).toBe(true);
    } finally {
      cleanup(p);
    }
  });

  test("no next chunk spawns, the job and marker stay, and the original pair is alive", async () => {
    const { w, d } = await world(largeDiff);
    const p = await pair();
    try {
      let calls = 0;
      w.reviewer = (_argv, options) => {
        calls++;
        options?.onSpawn?.({ pid: p.parent, kill: () => {} });
        return new Promise(() => {});
      };
      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));

      expect(await drainReviewQueue(d, { killTree: failKill, timeoutMs: 80 })).toEqual([
        {
          lane: "fix-login",
          action: "review-kill-failed",
          detail: "the reviewer tree is still alive; the job is kept for the next pass",
        },
      ]);
      expect(calls).toBe(1);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ state: "running" });
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(true);
      const receipt = d.store.laneReceipt("fix-login", tip);
      expect(receipt).toMatchObject({ verdict: "reviewer_timeout" });
      expect(receipt!.chunks?.map((c) => c.state)).toEqual(["timed out", "not run"]);
      expect(receipt!.chunks?.[0]?.note).toContain("kill failed");
      expect(receipt!.chunks?.[1]?.note).toContain("failed reviewer-tree kill");
      expect(alive(p.parent)).toBe(true);
      expect(alive(p.child)).toBe(true);
    } finally {
      cleanup(p);
    }
  });

  test("a BLOCK chunk followed by a failed kill is reviewer_timeout, not BLOCK", async () => {
    const { w, d } = await world(largeDiff);
    const p = await pair();
    try {
      let calls = 0;
      w.reviewer = (argv, options) => {
        calls++;
        const text = argv.at(-1) ?? "";
        if (text.includes("This is chunk 1 of 2")) return { code: 0, stdout: "VERDICT: BLOCK" };
        options?.onSpawn?.({ pid: p.parent, kill: () => {} });
        return new Promise(() => {});
      };
      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));

      expect(await drainReviewQueue(d, { killTree: failKill, timeoutMs: 80 })).toEqual([
        {
          lane: "fix-login",
          action: "review-kill-failed",
          detail: "the reviewer tree is still alive; the job is kept for the next pass",
        },
      ]);
      expect(calls).toBe(2);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ state: "running" });
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(true);
      const receipt = d.store.laneReceipt("fix-login", tip);
      expect(receipt).toMatchObject({ verdict: "reviewer_timeout" });
      expect(receipt!.chunks?.map((c) => c.state)).toEqual(["BLOCK", "timed out"]);
      expect(receipt!.summary).toContain("could not be killed");
      expect(alive(p.parent)).toBe(true);
      expect(alive(p.child)).toBe(true);
    } finally {
      cleanup(p);
    }
  });

  test("a BLOCK verdict printed before a failed kill is reviewer_timeout, not BLOCK", async () => {
    const { w, d } = await world(smallDiff);
    const p = await pair();
    try {
      let calls = 0;
      w.reviewer = (_argv, options) => {
        calls++;
        options?.onSpawn?.({ pid: p.parent, kill: () => {} });
        options?.onStdout?.("VERDICT: BLOCK\n");
        return new Promise(() => {});
      };
      await withWorker(d, () => queueLaneReview(d, "fix-login", undefined));

      expect(await drainReviewQueue(d, { killTree: failKill, timeoutMs: 80 })).toEqual([
        {
          lane: "fix-login",
          action: "review-kill-failed",
          detail: "the reviewer tree is still alive; the job is kept for the next pass",
        },
      ]);
      expect(calls).toBe(1);
      expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({ state: "running" });
      expect(existsSync(runPath(d.store.root, "fix-login", tip))).toBe(true);
      const receipt = d.store.laneReceipt("fix-login", tip);
      expect(receipt).toMatchObject({ verdict: "reviewer_timeout" });
      expect(receipt!.summary).toContain("could not be killed");
      expect(receipt!.summary).toContain("VERDICT: BLOCK");
      expect(alive(p.parent)).toBe(true);
      expect(alive(p.child)).toBe(true);
    } finally {
      cleanup(p);
    }
  });
});
