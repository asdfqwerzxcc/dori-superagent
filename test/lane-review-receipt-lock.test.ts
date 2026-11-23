import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const ownerFile = (d: ReturnType<typeof setup>["d"], key: string): string =>
  join(receiptLockPath(d.store.root, key, tip), "owner.json");

const markStale = (d: ReturnType<typeof setup>["d"], key: string): void => {
  const path = ownerFile(d, key);
  const owner = JSON.parse(readFileSync(path, "utf8")) as { token: string; pid: number; acquiredAt: number };
  writeFileSync(path, JSON.stringify({ ...owner, acquiredAt: Date.now() - RECEIPT_LOCK_TTL_MS - 1_000 }));
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

  test("a stale owner record is taken over", async () => {
    const { d } = setup();
    const lock = receiptLockPath(d.store.root, "stale", tip);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ token: "old", pid: 1, acquiredAt: Date.now() - RECEIPT_LOCK_TTL_MS - 1_000 }),
    );

    await saveFinalReceipt({ d, key: "stale", tip, receipt: receipt("stale", "CLEAR") });
    expect(canonical(d, "stale")?.verdict).toBe("CLEAR");
    expect(existsSync(lock)).toBe(false);
  });

  test("a stale holder that resumes cannot overwrite a newer CLEAR and leaves the new owner's lock alone", async () => {
    const { d } = setup();
    const aPaused = deferred();
    const aResume = deferred();
    const bWritten = deferred();
    const bResume = deferred();
    const a = saveFinalReceipt(
      { d, key: "preempt", tip, receipt: receipt("preempt", "reviewer_empty") },
      {
        beforeWrite: async () => {
          aPaused.resolve();
          await aResume.promise;
        },
      },
    );
    await aPaused.promise;
    markStale(d, "preempt");

    const b = saveFinalReceipt(
      { d, key: "preempt", tip, receipt: receipt("preempt", "CLEAR") },
      {
        beforeRelease: async () => {
          bWritten.resolve();
          await bResume.promise;
        },
      },
    );
    await bWritten.promise;
    aResume.resolve();
    const aSaved = await a;
    expect(aSaved).toEqual({ where: "sidecar", kept: "CLEAR" });
    expect(canonical(d, "preempt")?.verdict).toBe("CLEAR");
    expect(sidecar(d, "preempt")?.verdict).toBe("reviewer_empty");
    expect(existsSync(receiptLockPath(d.store.root, "preempt", tip))).toBe(true);

    bResume.resolve();
    await b;
    expect(existsSync(receiptLockPath(d.store.root, "preempt", tip))).toBe(false);
  });

  test("two sequential writers: the older epoch is refused at write time", async () => {
    const { d } = setup();
    const aPaused = deferred();
    const aResume = deferred();
    const a = saveFinalReceipt(
      { d, key: "seq", tip, receipt: receipt("seq", "reviewer_empty") },
      {
        beforeWrite: async () => {
          aPaused.resolve();
          await aResume.promise;
        },
      },
    );
    await aPaused.promise;
    markStale(d, "seq");

    expect(await saveFinalReceipt({ d, key: "seq", tip, receipt: receipt("seq", "CLEAR") })).toEqual({
      where: "canonical",
    });
    aResume.resolve();
    expect(await a).toEqual({ where: "sidecar", kept: "CLEAR" });
    expect(canonical(d, "seq")?.verdict).toBe("CLEAR");
    expect(sidecar(d, "seq")?.verdict).toBe("reviewer_empty");
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
}, { beforeWrite: async () => { await new Promise((r) => setTimeout(r, 50)); } });
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
