import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { progressPath, RECEIPT_LOCK_TTL_MS, receiptLockPath, saveFinalReceipt } from "../src/review-progress.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const receipt = (key: string, verdict: LaneReceipt["verdict"]): LaneReceipt => ({
  lane: key,
  verdict,
  base,
  tip,
  brief: "brief.md",
  reviewer: verdict,
  at: Date.now(),
  summary: verdict,
  chunks: [],
});

const sidecar = (root: string, key: string): LaneReceipt | undefined => {
  const path = progressPath(root, key, tip);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as LaneReceipt;
};

describe("lane review receipt lock", () => {
  test("a CLEAR writer holds the lock while a failing writer waits, then the failure goes to the sidecar", async () => {
    const { d } = setup();
    const hold = deferred();
    const waited = deferred();
    const clear = saveFinalReceipt(
      { d, key: "lock", tip, receipt: receipt("lock", "CLEAR") },
      {
        afterRead: async () => {
          await hold.promise;
        },
        onLockWait: () => waited.resolve(),
      },
    );
    const failure = saveFinalReceipt(
      { d, key: "lock", tip, receipt: receipt("lock", "reviewer_empty") },
      {
        onLockWait: () => waited.resolve(),
      },
    );
    await waited.promise;
    hold.resolve();
    await Promise.all([clear, failure]);

    expect(d.store.laneReceipt("lock", tip)?.verdict).toBe("CLEAR");
    expect(sidecar(d.store.root, "lock")?.verdict).toBe("reviewer_empty");
    expect(existsSync(receiptLockPath(d.store.root, "lock", tip))).toBe(false);
  });

  test("a stale lock is taken over", async () => {
    const { d } = setup();
    const lock = receiptLockPath(d.store.root, "stale", tip);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - RECEIPT_LOCK_TTL_MS - 1_000);
    utimesSync(lock, old, old);

    await saveFinalReceipt({ d, key: "stale", tip, receipt: receipt("stale", "CLEAR") });
    expect(d.store.laneReceipt("stale", tip)?.verdict).toBe("CLEAR");
    expect(existsSync(lock)).toBe(false);
  });

  test("two spawned writers converge on CLEAR, never on the failure", async () => {
    const { d } = setup();
    const storeUrl = pathToFileURL(join(import.meta.dir, "..", "src", "store.ts")).href;
    const progressUrl = pathToFileURL(join(import.meta.dir, "..", "src", "review-progress.ts")).href;
    const script = join(d.store.root, "writer.ts");
    writeFileSync(
      script,
      `import { Store } from ${JSON.stringify(storeUrl)};
import { saveFinalReceipt } from ${JSON.stringify(progressUrl)};
const [root, key, tip, verdict] = process.argv.slice(2);
const d = { store: new Store(root), now: Date.now };
await saveFinalReceipt({
  d, key, tip,
  receipt: { lane: key, verdict, base: "a".repeat(40), tip, brief: "brief.md", reviewer: verdict, at: Date.now(), summary: verdict, chunks: [] },
}, { afterRead: async () => { await new Promise((r) => setTimeout(r, 50)); } });
`,
    );
    const bun = Bun.which("bun") ?? process.execPath;
    const spawn = (verdict: string) =>
      Bun.spawn([bun, script, d.store.root, "spawned", tip, verdict], {
        env: process.env,
        stdout: "ignore",
        stderr: "pipe",
      });
    const clear = spawn("CLEAR");
    const failure = spawn("reviewer_empty");
    const [clearCode, failureCode] = await Promise.all([clear.exited, failure.exited]);
    const [clearErr, failureErr] = await Promise.all([
      new Response(clear.stderr).text(),
      new Response(failure.stderr).text(),
    ]);
    expect({ code: clearCode, stderr: clearErr }).toEqual({ code: 0, stderr: "" });
    expect({ code: failureCode, stderr: failureErr }).toEqual({ code: 0, stderr: "" });

    expect(d.store.laneReceipt("spawned", tip)?.verdict).toBe("CLEAR");
    expect(existsSync(receiptLockPath(d.store.root, "spawned", tip))).toBe(false);
  });
});
