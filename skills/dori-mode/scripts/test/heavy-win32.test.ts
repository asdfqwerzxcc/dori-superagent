import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_STALE_MS, platformLock, underDirLock, underLock } from "../src/heavy-lock.ts";
import { acquireSlot, type HeavyPolicy, heldSlots, releaseSlot } from "../src/heavy-slot.ts";
import { fakeClock, withState } from "./fakes.ts";

// The win32 fallback: no flock(2) and no load/memory probe, so heavy admits a fixed floor of slots behind a lock
// directory. The platform lock and the end-to-end spawn are win32's; the rest holds on every platform.
const win32 = process.platform === "win32";
const staticPolicy: HeavyPolicy = {
  minSlots: 1,
  maxSlots: 4,
  maxLoad: 10,
  jobMemGb: 4,
  memFreeMinPct: 15,
  staticSlots: true,
};

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("win32 asks for no flock(2); the platform lock is the directory lock", () => {
  expect(platformLock("win32")).toBeUndefined();
});

test("the directory lock excludes a second holder until the first section ends", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  let innerRan = false;
  let inner: Promise<string> = Promise.resolve("");
  await underLock(
    dir,
    () => {
      inner = underLock(
        dir,
        () => {
          innerRan = true;
          return "inner";
        },
        () => undefined,
      );
      expect(innerRan).toBe(false);
    },
    () => undefined,
  );
  expect(await inner).toBe("inner");
});

test("a lock left by a dead holder is taken over at once, with no stale wait", async () => {
  const dir = join(state.dir, "heavy");
  const lock = join(dir, ".lock.dir");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), "999999");
  const started = Date.now();
  expect(await underDirLock(dir, () => "taken")).toBe("taken");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(lock)).toBe(false);
});

test("a lock with no owner file is taken over only once it is LOCK_STALE_MS old", async () => {
  const dir = join(state.dir, "heavy");
  const lock = join(dir, ".lock.dir");
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
  utimesSync(lock, old, old);
  expect(await underDirLock(dir, () => "taken")).toBe("taken");
});

test("static slots are the floor, decided without sampling the host, and released for the next job", async () => {
  const dir = join(state.dir, "heavy");
  const logs: string[] = [];
  const deps = {
    dir,
    policy: staticPolicy,
    clock: fakeClock(Date.now()),
    pid: 7,
    alive: () => true,
    log: (l: string) => logs.push(l),
    host: async () => {
      throw new Error("the static fallback must not sample the host");
    },
  };
  const slot = await acquireSlot(deps, "first", 1);
  expect(slot).toBe(join(dir, "slot.1"));
  expect(logs[0]).toStartWith("HEAVY_START first limit 1 static slots");
  await expect(
    acquireSlot(
      { ...deps, clock: { ...fakeClock(Date.now()), sleep: async () => Promise.reject(new Error("waits")) } },
      "second",
      1,
    ),
  ).rejects.toThrow("waits");
  expect(heldSlots(deps)).toHaveLength(1);
  releaseSlot(slot);
  expect(await acquireSlot(deps, "third", 1)).toBe(join(dir, "slot.1"));
  releaseSlot(slot);
});

test.skipIf(!win32)("dori heavy runs the command on win32 instead of dying at flock(2)", () => {
  const config = join(state.dir, "config.json");
  const stateDir = join(state.dir, "state");
  writeFileSync(config, "{}");
  const cli = join(import.meta.dir, "../src/cli.ts");
  const env = { ...process.env, DORI_CONFIG: config, DORI_STATE_DIR: stateDir };
  const host = Bun.spawnSync(
    [process.execPath, cli, "heavy", "w32", "--", process.execPath, "-e", "console.log('HEAVY_CHILD_OK')"],
    { env, windowsHide: true },
  );
  expect(host.stderr.toString()).toContain("HEAVY_START w32 limit 1 static slots");
  expect(host.stdout.toString()).toContain("HEAVY_CHILD_OK");
  expect(host.exitCode).toBe(0);
  expect(readdirSync(join(stateDir, "heavy"))).toEqual([]);
  const status = Bun.spawnSync([process.execPath, cli, "heavy", "--status"], { env, windowsHide: true });
  expect(status.stdout.toString()).toContain("HEAVY OPEN limit 1 static slots");
  expect(status.exitCode).toBe(0);
});
