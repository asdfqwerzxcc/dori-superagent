import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginLockHeld, readPluginLock } from "../src/plugins/plugin.ts";
import { acquirePluginLock, lockHeldByRecord, releaseLockIfOwner } from "../src/plugins/run.ts";
import { processStartTimeMs } from "../src/process-liveness.ts";

const NOW = 1_800_000_000_000;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-lock-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const lockPath = (home: string): string => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  return join(home, "state", "plugins", "ensure-up.lock");
};

const lockDirOf = (path: string): string => `${path}.d`;
const ownerPath = (path: string): string => join(lockDirOf(path), "owner.json");

const ownerPid = (path: string): number => (JSON.parse(readFileSync(ownerPath(path), "utf8")) as { pid: number }).pid;

const writeOwner = (path: string, record: unknown): void => {
  mkdirSync(lockDirOf(path), { recursive: true });
  writeFileSync(ownerPath(path), JSON.stringify(record));
};

const writeHistorical = (path: string, record: unknown): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
};

describe("the plugin lock record", () => {
  test("a version 1 lock is held only by a pid whose recorded start time matches", () => {
    const raw = { version: 1, pid: 7004, at: NOW, startedAt: NOW };
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => NOW })).toBe(true);
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => NOW + 60_000 })).toBe(false);
    expect(lockHeldByRecord(raw, { alive: () => false, started: () => NOW })).toBe(false);
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => null })).toBe(true);
  });

  test("a null or corrupt start is doubt only while the record is fresh, so a stale external lock recovers", () => {
    for (const startedAt of [null, "garbage"]) {
      const raw = { version: 1, pid: 7004, at: NOW - 1_000, startedAt };
      expect(lockHeldByRecord(raw, { alive: () => true, now: () => NOW })).toBe(true);
      expect(lockHeldByRecord({ ...raw, at: NOW - 120_000 }, { alive: () => true, now: () => NOW })).toBe(false);
    }
  });

  test("an old-format lock is unversioned: a live holder is doubt, a dead one is stale", () => {
    const old = { pid: 7004, at: NOW };
    expect(lockHeldByRecord(old, { alive: () => true })).toBe(true);
    expect(lockHeldByRecord(old, { alive: () => false })).toBe(false);
  });
});

describe("the plugin lock directory", () => {
  test("a lock is taken over only when the holder is dead or its start time is reused", () => {
    const held = homeWithState();
    const heldLock = lockPath(held);
    writeHistorical(heldLock, {
      version: 1,
      pid: process.ppid,
      at: Date.now(),
      startedAt: processStartTimeMs(process.ppid),
    });
    expect(acquirePluginLock(heldLock)).toBe(false);
    expect(existsSync(lockDirOf(heldLock))).toBe(false);

    const stale = homeWithState();
    const staleLock = lockPath(stale);
    writeHistorical(staleLock, { version: 1, pid: process.ppid, at: Date.now(), startedAt: NOW });
    expect(acquirePluginLock(staleLock)).toBe(true);
    expect(ownerPid(staleLock)).toBe(process.pid);
  });

  test("a stale self-pid lock is taken over", () => {
    const home = homeWithState();
    const path = lockPath(home);
    const own = processStartTimeMs(process.pid);
    writeHistorical(path, { version: 1, pid: process.pid, at: Date.now(), startedAt: (own ?? Date.now()) + 60_000 });
    expect(acquirePluginLock(path)).toBe(true);
    expect(ownerPid(path)).toBe(process.pid);
  });

  test("an old-format lock with a dead pid is taken over and a second contender cannot take the new one", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeHistorical(path, { pid: 7004, at: Date.now() });
    expect(acquirePluginLock(path, { alive: () => false })).toBe(true);
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("two contenders racing for a stale lock produce one holder", async () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeHistorical(path, { version: 1, pid: 0, at: NOW, startedAt: NOW });
    const script = `import { acquirePluginLock } from "./src/plugins/run.ts"; const ok = acquirePluginLock(${JSON.stringify(
      path,
    )}); console.log(ok ? "yes" : "no"); if (ok) await Bun.sleep(1000);`;
    const run = () =>
      Bun.spawn({
        cmd: ["bun", "-e", script],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
    const a = run();
    const b = run();
    const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    await Promise.all([a.exited, b.exited]);
    expect([outA.trim(), outB.trim()].sort()).toEqual(["no", "yes"]);
  });

  test("a delayed takeover cannot rename a fresh owner's lock", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeOwner(path, { version: 1, token: "stale", pid: 7003, at: 100, startedAt: 100 });
    const fresh = 7100;
    let swapped = false;
    const deps = {
      alive: (pid: number) => pid === 7003 || pid === fresh,
      started: (pid: number) => {
        if (pid !== 7003) return 50_000;
        // A fresh owner appears after the stale record was judged, before the generation CAS re-reads it.
        swapped = true;
        writeOwner(path, { version: 1, token: "fresh", pid: fresh, at: 200, startedAt: 50_000 });
        return 50_000;
      },
    };
    expect(acquirePluginLock(path, deps)).toBe(false);
    expect(swapped).toBe(true);
    const remaining = JSON.parse(readFileSync(ownerPath(path), "utf8")) as { pid: number; token: string };
    expect(remaining.pid).toBe(fresh);
    expect(remaining.token).toBe("fresh");
  });

  test("a claim writes a complete owner inside the directory", () => {
    const home = homeWithState();
    const path = lockPath(home);
    expect(acquirePluginLock(path)).toBe(true);
    const record = JSON.parse(readFileSync(ownerPath(path), "utf8")) as { pid: number; token: string };
    expect(record.pid).toBe(process.pid);
    expect(typeof record.token).toBe("string");
    expect(readdirSync(lockDirOf(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a truncated owner with a live temp claimant is doubt, not absent", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(lockDirOf(path));
    writeFileSync(ownerPath(path), "{");
    writeFileSync(join(lockDirOf(path), `.owner.${process.ppid}.abc.tmp`), "{");
    expect(readPluginLock(home, "ensure-up")).toEqual({ pid: process.ppid, at: 0, startedAt: null });
    expect(pluginLockHeld(home, "ensure-up")).toBe(true);
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("a claim whose write cannot read the start time still holds, and the record on disk is null", () => {
    const home = homeWithState();
    const path = lockPath(home);
    const real = processStartTimeMs(process.pid) ?? 1;
    let calls = 0;
    const started = (): number | null => (calls++ === 0 ? null : real);
    expect(acquirePluginLock(path, { started })).toBe(true);
    const record = JSON.parse(readFileSync(ownerPath(path), "utf8")) as { startedAt: unknown };
    expect(record.startedAt).toBeNull();
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("the same lock protocol serves another plugin: live legacy is doubt, dead legacy is stale", () => {
    const home = homeWithState();
    mkdirSync(join(home, "state", "plugins"), { recursive: true });
    const path = join(home, "state", "plugins", "other.lock");
    writeHistorical(path, { pid: process.ppid, at: Date.now() });
    expect(acquirePluginLock(path, { alive: () => true })).toBe(false);
    expect(acquirePluginLock(path, { alive: () => false })).toBe(true);
  });

  test("a release removes only this process's lock", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeOwner(path, { version: 1, pid: process.ppid, at: Date.now() });
    writeHistorical(path, { version: 1, pid: process.ppid, at: Date.now() });
    releaseLockIfOwner(path);
    expect(existsSync(lockDirOf(path))).toBe(true);
    expect(existsSync(path)).toBe(true);

    writeOwner(path, { version: 1, pid: process.pid, at: Date.now(), startedAt: processStartTimeMs(process.pid) });
    writeHistorical(path, { version: 1, pid: process.pid, at: Date.now() });
    releaseLockIfOwner(path);
    expect(existsSync(lockDirOf(path))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
