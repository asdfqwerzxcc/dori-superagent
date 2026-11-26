import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HeavyAdmissionError,
  LOCK_STALE_MS,
  platformLock,
  processStart,
  underFileLock,
  underLock,
} from "../src/heavy-lock.ts";
import { acquireSlot, type HeavyPolicy, heldSlots, releaseSlot } from "../src/heavy-slot.ts";
import { fakeClock, withState } from "./fakes.ts";

// The win32 fallback: no flock(2) and no load average, so heavy admits a fixed floor of slots behind one lock file.
// The platform lock and the end-to-end spawn are win32's; the lock-file tests run on every platform.
const win32 = process.platform === "win32";
const staticPolicy: HeavyPolicy = {
  minSlots: 1,
  maxSlots: 4,
  maxLoad: 10,
  jobMemGb: 4,
  memFreeMinPct: 15,
  staticSlots: true,
};
const start = "2026-01-01T00:00:00.000Z";
const otherStart = "2026-06-01T00:00:00.000Z";
const probeStart = () => start;
const probeOther = () => otherStart;
const owner = (pid: number, at = start, nonce = "someone-else") => JSON.stringify({ pid, start: at, nonce });

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("win32 asks for no flock(2); the platform lock is the lock file", () => {
  expect(platformLock("win32")).toBeUndefined();
});

test("the start-time probe answers the process's own start", () => {
  const probed = processStart(process.pid);
  expect(probed).toBeDefined();
  expect(Math.abs(Date.parse(probed as string) - performance.timeOrigin)).toBeLessThan(2_000);
});

test("two processes racing for the lock file: exactly one is inside at a time", async () => {
  const dir = join(state.dir, "heavy");
  const log = join(state.dir, "turns.log");
  mkdirSync(dir, { recursive: true });
  const child = `
    const { underLock } = await import(${JSON.stringify(join(import.meta.dir, "../src/heavy-lock.ts"))});
    const { appendFileSync } = await import("node:fs");
    await underLock(${JSON.stringify(dir)}, async () => {
      appendFileSync(${JSON.stringify(log)}, "IN\\n");
      await Bun.sleep(300);
      appendFileSync(${JSON.stringify(log)}, "OUT\\n");
    }, () => undefined);
  `;
  const procs = [1, 2].map(() =>
    Bun.spawn([process.execPath, "-e", child], { stdout: "pipe", stderr: "pipe", windowsHide: true }),
  );
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);
  expect(readFileSync(log, "utf8").trim().split(/\r?\n/)).toEqual(["IN", "OUT", "IN", "OUT"]);
});

test("a lock left by a dead holder is taken over at once", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".lock"), owner(999_999));
  expect(await underFileLock(dir, () => "taken", probeStart)).toBe("taken");
});

test("a live holder with the recorded start time keeps the lock", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".lock"), owner(process.pid));
  const waiter = underFileLock(dir, () => "entered", probeStart);
  expect(await Promise.race([waiter, Bun.sleep(300).then(() => "waited")])).toBe("waited");
  rmSync(join(dir, ".lock"), { force: true });
  expect(await waiter).toBe("entered");
});

test("a pid that was reused is taken over: the same pid, a different start time", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".lock"), owner(process.pid));
  expect(await underFileLock(dir, () => "taken", probeOther)).toBe("taken");
});

test("a start time that cannot be read refuses admission instead of taking the lock", async () => {
  const dir = join(state.dir, "heavy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".lock"), owner(process.pid));
  await expect(
    underFileLock(
      dir,
      () => "entered",
      () => undefined,
    ),
  ).rejects.toThrow(HeavyAdmissionError);
});

test("a lock file without a readable record is not taken while it is young", async () => {
  const dir = join(state.dir, "young");
  const lock = join(dir, ".lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "");
  const waiter = underFileLock(dir, () => "entered", probeStart);
  expect(await Promise.race([waiter, Bun.sleep(300).then(() => "waited")])).toBe("waited");
  rmSync(lock, { force: true });
  expect(await waiter).toBe("entered");
});

test("a lock file without a readable record is taken over once it is stale", async () => {
  const dir = join(state.dir, "old");
  const lock = join(dir, ".lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "");
  const old = new Date(Date.now() - LOCK_STALE_MS - 1_000);
  utimesSync(lock, old, old);
  expect(await underFileLock(dir, () => "taken", probeStart)).toBe("taken");
});

test("the lock file excludes a second holder until the first section ends", async () => {
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
        probeStart,
      );
      expect(innerRan).toBe(false);
    },
    () => undefined,
    probeStart,
  );
  expect(await inner).toBe("inner");
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
  expect(host.stderr.toString()).toContain("no load average");
  expect(host.stdout.toString()).toContain("HEAVY_CHILD_OK");
  expect(host.exitCode).toBe(0);
  expect(readdirSync(join(stateDir, "heavy"))).toEqual([]);
  const status = Bun.spawnSync([process.execPath, cli, "heavy", "--status"], { env, windowsHide: true });
  expect(status.stdout.toString()).toContain("HEAVY OPEN limit 1 static slots");
  expect(status.exitCode).toBe(0);
});
