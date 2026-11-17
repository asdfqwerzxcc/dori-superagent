import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { acquire, release } from "../src/loop-lock.ts";
import { reviewJobFor } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

/** A lane that committed one diff and is ready to land at `tip`. */
async function world() {
  const s = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(s.w, repo);
  await startLane(s.d, "fix-login", s.brief, { group: "w1" });
  await ready(s.d, "fix-login", "fixed", ["file:///x"]);
  repo.head = tip;
  return { ...s, repo };
}

/** Holds the duty lock, as a running duty loop does, for the duration of `run`. */
async function withWorker<R>(d: Deps, run: () => Promise<R>): Promise<R> {
  const held = acquire(d, d.store.lockPath("duty"));
  if ("holder" in held) throw new Error(held.holder);
  try {
    return await run();
  } finally {
    release(d, held.nonce, d.store.lockPath("duty"));
  }
}

const queue = (d: Deps) => captureIo(() => main(["review", "--lane", "fix-login"], d));

describe("queued lane review", () => {
  test("review --lane with a worker queues; the duty pass runs it and the lead gets one inbox message", async () => {
    const { w, d, lead } = await world();
    const request = await withWorker(d, () =>
      captureIo(() => main(["review", "--lane", "fix-login", "--model", "some/model"], d)),
    );
    expect(request).toEqual({ code: 0, out: `QUEUED fix-login ${tip} fix-login@${tip}` });
    expect(w.calls.filter((c) => c.cmd === "omo")).toEqual([]);
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toMatchObject({
      lane: "fix-login",
      tip,
      base,
      model: "some/model",
      state: "queued",
    });

    const before = lead.received.length;
    expect(await dutyTick(d)).toEqual([{ lane: "fix-login", action: "review-done", detail: `CLEAR at ${tip}` }]);
    const reviewers = w.calls.filter((c) => c.cmd === "omo");
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]!.argv).toContain("some/model");
    expect(d.store.laneReceipt("fix-login", tip)).toMatchObject({ verdict: "CLEAR", base, tip });
    const receipt = join(d.store.root, "receipts", `lane_fix-login@${tip}.json`);
    expect(lead.received.slice(before)).toEqual([`[REVIEW fix-login] CLEAR at ${tip}; receipt ${receipt}`]);
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
  });

  test("a second request for the same lane and tip returns the existing job", async () => {
    const { w, d } = await world();
    const first = await withWorker(d, () => queue(d));
    w.clock += 60_000;
    const second = await withWorker(d, () => queue(d));
    expect(second.out).toBe(first.out);
    expect(readdirSync(join(d.store.root, "state", "review-queue"))).toEqual([`fix-login@${tip}.json`]);
    expect(reviewJobFor(d.store.root, "fix-login", tip)!.requestedAt).toBe(w.clock - 60_000);
  });

  test("done refuses while the review is in flight and lands after the receipt appears", async () => {
    const { d } = await world();
    await withWorker(d, () => queue(d));
    const refusal = await done(d, "fix-login").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((refusal as Error).message).toContain("review is in flight");
    expect((refusal as Error).message).toContain("inbox message from duty");
    expect(d.store.lane("fix-login")!.status).toBe("ready");

    const pass = await captureIo(() => main(["duty", "--once"], d));
    expect(pass).toEqual({ code: 0, out: `DUTY fix-login review-done: CLEAR at ${tip}` });
    expect(await done(d, "fix-login")).toBeUndefined();
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });

  test("a failed review posts the failure to the lead and leaves nothing pending", async () => {
    const { w, d, lead } = await world();
    w.reviewer = () => ({ code: 0, stdout: "no verdict here", stderr: "provider warning" });
    await withWorker(d, () => queue(d));
    const before = lead.received.length;
    expect(await dutyTick(d)).toEqual([
      { lane: "fix-login", action: "review-failed", detail: expect.stringContaining("no VERDICT") },
    ]);
    const [message] = lead.received.slice(before);
    expect(message).toStartWith(`[REVIEW fix-login] failed at ${tip}: `);
    expect(message).toContain("no VERDICT");
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
    await expect(done(d, "fix-login")).rejects.toThrow("no review receipt");
  });

  test("a corrupt job record is dropped instead of wedging review, done and the drain", async () => {
    const { d } = await world();
    const dir = join(d.store.root, "state", "review-queue");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `fix-login@${tip}.json`);
    writeFileSync(path, "{ not json");
    await expect(done(d, "fix-login")).rejects.toThrow("no review receipt");
    expect(await dutyTick(d)).toContainEqual({ action: "review-record-dropped", detail: `fix-login@${tip}.json` });
    expect(existsSync(path)).toBe(false);
    expect(await captureIo(() => main(["review", "--lane", "fix-login"], d))).toEqual({
      code: 0,
      out: `REVIEW_LANE fix-login tip=${tip} verdict=CLEAR`,
    });
  });

  test("with no duty worker, review --lane reviews inline and drops the stale job record", async () => {
    const { w, d } = await world();
    await withWorker(d, () => queue(d));
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeDefined();
    const inline = await captureIo(() => main(["review", "--lane", "fix-login", "--model", "fast/model"], d));
    expect(inline).toEqual({ code: 0, out: `REVIEW_LANE fix-login tip=${tip} verdict=CLEAR` });
    expect(w.calls.filter((c) => c.cmd === "omo")).toHaveLength(1);
    expect(d.store.laneReceipt("fix-login", tip)!.reviewer).toContain("--model fast/model");
    expect(reviewJobFor(d.store.root, "fix-login", tip)).toBeUndefined();
  });
});
