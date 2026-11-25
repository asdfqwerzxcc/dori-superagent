import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { status } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { reviewJobFor } from "../src/review-queue.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);
const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

/** A lane that committed one diff and is ready to land at `tip`; `keys` starts more than one. */
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

const queue = (d: Deps, extra: readonly string[] = []) =>
  captureIo(() => main(["review", "--lane", "fix-login", ...extra], d));

const queued = (d: Deps) => reviewJobFor(d.store.root, "fix-login", tip);
const queueDir = (d: Deps) => join(d.store.root, "state", "review-queue");

describe("queued lane review", () => {
  test("review --lane records one request and spawns nothing, even with no duty loop", async () => {
    const { w, d } = await world();
    expect(await queue(d)).toEqual({ code: 0, out: `QUEUED fix-login ${tip} fix-login@${tip}` });
    expect(w.calls.filter((c) => c.cmd === "omo")).toEqual([]);
    expect(queued(d)).toMatchObject({ lane: "fix-login", tip, base, state: "queued" });
    expect(readFileSync(d.store.laneDiffPath("fix-login", tip), "utf8")).toBe(diff);
    expect(d.store.lane("fix-login")!.tipSha).toBe(tip);
    expect(d.store.laneReceipt("fix-login", tip)).toBeUndefined();
  });

  test("a second request returns the queued record; the drain reports it and creates no process", async () => {
    const { w, d } = await world();
    expect((await queue(d)).out).toBe(`QUEUED fix-login ${tip} fix-login@${tip}`);
    w.clock += 60_000;
    expect((await queue(d)).out).toBe(`already queued fix-login@${tip} (queued)`);
    expect(readdirSync(queueDir(d))).toEqual([`fix-login@${tip}.json`]);
    expect(queued(d)).toMatchObject({ requestedAt: w.clock - 60_000, state: "queued" });

    const before = w.calls.length;
    expect(await dutyTick(d)).toEqual([
      { lane: "fix-login", action: "review-queued", detail: "queued, waiting 1m for the lead's receipt" },
    ]);
    expect(w.calls.length).toBe(before);
    expect(w.calls.filter((c) => c.cmd === "omo")).toEqual([]);
    expect(queued(d)).toMatchObject({ state: "queued" });
    expect(d.store.laneReceipt("fix-login", tip)).toBeUndefined();
  });

  test("the drain never expires a request: age is reported, the record stays and no process starts", async () => {
    const { w, d } = await world();
    await queue(d);
    w.clock += 25 * 60 * 60 * 1000;
    const before = w.calls.length;
    expect(await dutyTick(d)).toContainEqual({
      lane: "fix-login",
      action: "review-queued",
      detail: "queued, waiting 1500m for the lead's receipt",
    });
    expect(w.calls.length).toBe(before);
    expect(queued(d)).toMatchObject({ state: "queued" });
    expect(existsSync(join(queueDir(d), `fix-login@${tip}.json`))).toBe(true);
    expect(d.store.laneReceipt("fix-login", tip)).toBeUndefined();
  });

  test("the drain drops an unreadable record without touching a process", async () => {
    const { w, d } = await world();
    mkdirSync(queueDir(d), { recursive: true });
    writeFileSync(join(queueDir(d), "not-a-job.json"), "{ not json");
    const before = w.calls.length;
    expect(await dutyTick(d)).toContainEqual({ action: "review-record-dropped", detail: "not-a-job.json" });
    expect(w.calls.length).toBe(before);
    expect(existsSync(join(queueDir(d), "not-a-job.json"))).toBe(false);
  });

  test("done refuses the queued tip and names the attestation command", async () => {
    const { d } = await world();
    await queue(d);
    const refusal: unknown = await done(d, "fix-login").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("a review request is queued");
    expect((refusal as Error).message).toContain("--attest");
    expect(d.store.lane("fix-login")!.status).toBe("ready");
  });

  test("status prints review=queued while the request waits", async () => {
    const { d } = await world();
    await queue(d);
    const { out } = await captureIo(async () => {
      await status(d);
      return 0;
    });
    expect(out.split("\n").find((line) => line.startsWith("fix-login"))).toContain("review=queued");
  });

  test("a PR and --lane together are still refused", async () => {
    const { d } = await world();
    await expect(main(["review", "o/r#1", "--lane", "fix-login"], d)).rejects.toThrow("not both");
  });
});
