import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { withReceiptLock } from "../src/receipt-lock.ts";
import { receiptLockPath, saveFinalReceipt } from "../src/review-progress.ts";
import type { LaneReceipt } from "../src/store-types.ts";
import { setup } from "./harness-setup.ts";

const base = "a".repeat(40);
const tip = "b".repeat(40);

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
const ownerPath = (lock: string): string => join(lock, "owner.json");
const owner = (token: string, pid: number, startTime: number | null) => ({
  token,
  pid,
  startTime,
  host: hostname(),
  acquiredAt: Date.now() - 5_000,
});
const writeOwner = (lock: string, value: ReturnType<typeof owner>): void => {
  mkdirSync(lock, { recursive: true });
  writeFileSync(ownerPath(lock), JSON.stringify(value));
};
const failed = async (run: () => Promise<unknown>): Promise<Error> => {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

describe("lane review lock owner identity", () => {
  test("a live pid with a different start time is a reused pid and is taken over", async () => {
    const { d } = setup();
    const key = "reuse";
    const lock = receiptLockPath(d.store.root, key, tip);
    writeOwner(lock, owner("old", process.pid, 1));

    expect(await saveFinalReceipt({ d, key, tip, receipt: receipt(key, "CLEAR") }, { waitMs: 500 })).toEqual({
      where: "canonical",
    });
    expect(canonical(d, key)?.verdict).toBe("CLEAR");
    expect(existsSync(lock)).toBe(false);
  });

  test("a live owner with an unreadable start time is treated as live, never stolen", async () => {
    const { d } = setup();
    const key = "unreadable";
    const lock = receiptLockPath(d.store.root, key, tip);
    writeOwner(lock, owner("old", process.pid, null));

    const error = await failed(() =>
      saveFinalReceipt({ d, key, tip, receipt: receipt(key, "CLEAR") }, { waitMs: 200 }),
    );
    expect(error.message).toContain("cannot be verified");
    expect(error.message).toContain("treated as live");
    expect(canonical(d, key)).toBeUndefined();
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(ownerPath(lock), "utf8")).token).toBe("old");
  });

  test("a critical-section EPERM propagates, is not retried, and releases the lock", async () => {
    const { d } = setup();
    const key = "eperm";
    let attempts = 0;

    const error = await failed(() =>
      saveFinalReceipt(
        { d, key, tip, receipt: receipt(key, "CLEAR") },
        {
          waitMs: 200,
          beforeWrite: () => {
            attempts += 1;
            const e = new Error("write denied") as NodeJS.ErrnoException;
            e.code = "EPERM";
            throw e;
          },
        },
      ),
    );
    expect(attempts).toBe(1);
    expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(error.message).toBe("write denied");
    expect(canonical(d, key)).toBeUndefined();
    expect(existsSync(receiptLockPath(d.store.root, key, tip))).toBe(false);
  });

  test("a release that lost ownership reports the true owner", async () => {
    const { d } = setup();
    const key = "release";
    const lock = receiptLockPath(d.store.root, key, tip);

    const error = await failed(() =>
      saveFinalReceipt(
        { d, key, tip, receipt: receipt(key, "CLEAR") },
        {
          beforeWrite: () => {
            const current = JSON.parse(readFileSync(ownerPath(lock), "utf8"));
            writeFileSync(ownerPath(lock), JSON.stringify({ ...current, token: "intruder" }));
          },
        },
      ),
    );
    expect(error.message).toContain("lost ownership");
    expect(error.message).toContain("intruder");
    expect(canonical(d, key)?.verdict).toBe("CLEAR");
    expect(JSON.parse(readFileSync(ownerPath(lock), "utf8")).token).toBe("intruder");
  });

  test("a release rename failure surfaces and leaves the lock with its live owner", async () => {
    const { d } = setup();
    const key = "release-rename";
    const lock = receiptLockPath(d.store.root, key, tip);

    const error = await failed(() =>
      saveFinalReceipt(
        { d, key, tip, receipt: receipt(key, "CLEAR") },
        {
          beforeWrite: () => {
            const current = JSON.parse(readFileSync(ownerPath(lock), "utf8"));
            const tomb = `${lock}.released.${current.token}`;
            mkdirSync(tomb, { recursive: true });
            writeFileSync(join(tomb, "block"), "x");
          },
        },
      ),
    );
    expect((error as NodeJS.ErrnoException).code).toMatch(/^(EPERM|EEXIST|ENOTEMPTY)$/);
    expect(canonical(d, key)?.verdict).toBe("CLEAR");
    expect(existsSync(lock)).toBe(true);
  });

  test("a taker that renamed a new owner's lock restores it instead of tombstoning it", async () => {
    const { d } = setup();
    const key = "rename-back";
    const lock = receiptLockPath(d.store.root, key, tip);
    const bun = Bun.which("bun") ?? process.execPath;
    const dead = Bun.spawn([bun, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
    await dead.exited;
    writeOwner(lock, owner("dead", dead.pid, 1));
    let replaced = 0;
    let ran = 0;

    const error = await failed(() =>
      withReceiptLock(
        d.store.root,
        key,
        tip,
        () => {
          ran += 1;
        },
        {
          waitMs: 200,
          beforeTakeOverRename: () => {
            replaced += 1;
            rmSync(lock, { recursive: true, force: true });
            writeOwner(lock, owner("new", process.pid, null));
          },
        },
      ),
    );
    expect(error.message).toContain("treated as live");
    expect(replaced).toBe(1);
    expect(ran).toBe(0);
    expect(JSON.parse(readFileSync(ownerPath(lock), "utf8")).token).toBe("new");
  });
});
