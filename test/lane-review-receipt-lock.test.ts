import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RECEIPT_LOCK_TTL_MS, receiptLockPath, saveFinalReceipt } from "../src/review-progress.ts";
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

const canonical = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt | undefined =>
  d.store.laneReceipt(key, tip);

const sidecar = (d: ReturnType<typeof setup>["d"], key: string): LaneReceipt | undefined => {
  const path = join(d.store.root, "state", "reviews", `${key}@${tip}.progress.json`);
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
        beforeWrite: async () => {
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

    expect(canonical(d, "lock")?.verdict).toBe("CLEAR");
    expect(sidecar(d, "lock")?.verdict).toBe("reviewer_empty");
    expect(existsSync(receiptLockPath(d.store.root, "lock", tip))).toBe(false);
  });

  test("a bare legacy lock directory is taken over after the TTL and two waiters do not wedge", async () => {
    const { d } = setup();
    const lock = receiptLockPath(d.store.root, "bare", tip);
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - RECEIPT_LOCK_TTL_MS - 1_000);
    utimesSync(lock, old, old);

    const results = await Promise.all([
      saveFinalReceipt({ d, key: "bare", tip, receipt: receipt("bare", "CLEAR") }, { waitMs: 1_000 }),
      saveFinalReceipt({ d, key: "bare", tip, receipt: receipt("bare", "CLEAR") }, { waitMs: 1_000 }),
    ]);
    expect(results.map((r) => r.where)).toEqual(["canonical", "canonical"]);
    expect(canonical(d, "bare")?.verdict).toBe("CLEAR");
    expect(existsSync(lock)).toBe(false);
  });

  test("the writerAt fence sends an older epoch to the sidecar", async () => {
    const { d } = setup();
    d.store.saveLaneReceipt({ ...receipt("fence", "CLEAR"), writerAt: Date.now() + 60_000 });

    expect(await saveFinalReceipt({ d, key: "fence", tip, receipt: receipt("fence", "reviewer_empty") })).toEqual({
      where: "sidecar",
      kept: "CLEAR",
    });
    expect(canonical(d, "fence")?.verdict).toBe("CLEAR");
    expect(sidecar(d, "fence")?.verdict).toBe("reviewer_empty");
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
}, { beforeWrite: async () => { await new Promise((r) => setTimeout(r, 50)); }, waitMs: 5_000 });
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

    expect(canonical(d, "spawned")?.verdict).toBe("CLEAR");
    expect(existsSync(receiptLockPath(d.store.root, "spawned", tip))).toBe(false);
  });
});
