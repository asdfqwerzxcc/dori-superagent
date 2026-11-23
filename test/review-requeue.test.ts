import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Deps } from "../src/harness.ts";
import { ready, startLane } from "../src/lanes.ts";
import { reviewJobFor } from "../src/review-queue.ts";
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

describe("replacing a queued lane review", () => {
  test("--restart replaces the request record and spawns nothing", async () => {
    const { w, d } = await world();
    expect((await queue(d)).out).toBe(`QUEUED fix-login ${tip} fix-login@${tip}`);
    const before = reviewJobFor(d.store.root, "fix-login", tip);
    if (before === undefined || before === "corrupt") throw new Error("the request was not queued");
    w.clock += 60_000;
    expect(await queue(d, ["--restart"])).toEqual({
      code: 0,
      out: `QUEUED fix-login ${tip} fix-login@${tip} (restarted)`,
    });
    const after = reviewJobFor(d.store.root, "fix-login", tip);
    if (after === undefined || after === "corrupt") throw new Error("the request was not replaced");
    expect(after).toMatchObject({ state: "queued", requestedAt: w.clock });
    expect(after.requestedAt).toBeGreaterThan(before.requestedAt);
    expect(readdirSync(join(d.store.root, "state", "review-queue"))).toEqual([`fix-login@${tip}.json`]);
    expect(w.calls.filter((c) => c.cmd === "omo")).toEqual([]);
  });

  test("--restart without an existing request prints a fresh QUEUED", async () => {
    const { d } = await world();
    expect(await queue(d, ["--restart"])).toEqual({
      code: 0,
      out: `QUEUED fix-login ${tip} fix-login@${tip}`,
    });
  });
});
