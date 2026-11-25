import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquirePluginLock, releaseLockIfOwner } from "../src/plugins/run.ts";
import { pidAlive } from "../src/process-liveness.ts";

const NOW = 1_800_000_000_000;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-mixed-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const lockPath = (home: string): string => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  return join(home, "state", "plugins", "ensure-up.lock");
};

const dirOf = (path: string): string => `${path}.d`;

/**
 * The released implementation, copied verbatim except for its imports: a plain JSON file written with `wx`, and a
 * takeover that removes whatever sits at the path. A directory there throws out of `rmSync`, which is the failure a
 * new lock directory at the historical path would cause.
 */
const oldAcquire = (path: string, ownPid = 9_001, alive: (pid: number) => boolean = pidAlive): boolean => {
  mkdirSync(dirname(path), { recursive: true });
  const write = (): boolean => {
    try {
      writeFileSync(path, JSON.stringify({ pid: ownPid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (write()) return true;
  try {
    const pid = Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid);
    if (Number.isInteger(pid) && pid !== ownPid && alive(pid)) return false;
  } catch {}
  rmSync(path, { force: true });
  return write();
};

describe("the new lock directory and the old file format", () => {
  test("an old-code child reads the new owner's mirror file, never a directory", () => {
    const home = homeWithState();
    const path = lockPath(home);
    expect(acquirePluginLock(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect(statSync(dirOf(path)).isDirectory()).toBe(true);
    expect(oldAcquire(path)).toBe(false);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  test("the new protocol waits out a live old-format holder and takes over only after it goes", () => {
    const home = homeWithState();
    const path = lockPath(home);
    const old = { pid: process.ppid, at: Date.now() };
    writeFileSync(path, JSON.stringify(old));
    expect(acquirePluginLock(path)).toBe(false);
    expect(existsSync(dirOf(path))).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(old);
    rmSync(path, { force: true });
    expect(acquirePluginLock(path)).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect(oldAcquire(path)).toBe(false);
  });

  test("an old-format holder whose pid is gone is taken over, and the mirror is then new-format", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: 7004, at: Date.now() }));
    expect(acquirePluginLock(path, { alive: () => false })).toBe(true);
    const mirror = JSON.parse(readFileSync(path, "utf8")) as { version: number; pid: number };
    expect(mirror.version).toBe(1);
    expect(mirror.pid).toBe(process.pid);
  });

  test("a stale lock directory at the historical path from an earlier layout is migrated", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ version: 1, token: "old", pid: 7004, at: NOW - 120_000, startedAt: null }),
    );
    expect(acquirePluginLock(path, { alive: () => true, now: () => NOW })).toBe(true);
    expect(statSync(path).isFile()).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  test("a live lock directory at the historical path is doubt, not a takeover", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ version: 1, token: "old", pid: 7004, at: NOW, startedAt: NOW }),
    );
    expect(acquirePluginLock(path, { alive: () => true, started: () => NOW, now: () => NOW })).toBe(false);
    expect(statSync(path).isDirectory()).toBe(true);
  });

  test("a stale external lock directory with a live pid and a null start recovers", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(dirOf(path));
    writeFileSync(
      join(dirOf(path), "owner.json"),
      JSON.stringify({ version: 1, token: "old", pid: 7004, at: NOW - 120_000, startedAt: null }),
    );
    expect(acquirePluginLock(path, { alive: () => true, now: () => NOW })).toBe(true);
    expect((JSON.parse(readFileSync(join(dirOf(path), "owner.json"), "utf8")) as { pid: number }).pid).toBe(
      process.pid,
    );
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  test("a null start that is still fresh is doubt, so a live owner is not taken over", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(dirOf(path));
    writeFileSync(
      join(dirOf(path), "owner.json"),
      JSON.stringify({ version: 1, token: "old", pid: 7004, at: NOW - 1_000, startedAt: null }),
    );
    expect(acquirePluginLock(path, { alive: () => true, now: () => NOW })).toBe(false);
    expect((JSON.parse(readFileSync(join(dirOf(path), "owner.json"), "utf8")) as { pid: number }).pid).toBe(7004);
  });

  const tickPath = (path: string): string => path.replace(/\.lock$/, ".tick");

  test("a corrupt historical file is replaced instead of blocking every claim", () => {
    for (const raw of ["{", "", "null", '"x"']) {
      const home = homeWithState();
      const path = lockPath(home);
      writeFileSync(path, raw);
      expect(acquirePluginLock(path)).toBe(true);
      expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
      expect(statSync(dirOf(path)).isDirectory()).toBe(true);
      releaseLockIfOwner(path);
    }
  });

  test("an ownerless lock directory older than the claim grace recovers past a dead historical file", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(dirOf(path));
    const old = new Date(Date.now() - 60_000);
    utimesSync(dirOf(path), old, old);
    writeFileSync(path, JSON.stringify({ pid: 7004, at: NOW }));
    expect(acquirePluginLock(path, { alive: () => false, now: () => NOW })).toBe(true);
    expect((JSON.parse(readFileSync(join(dirOf(path), "owner.json"), "utf8")) as { pid: number }).pid).toBe(
      process.pid,
    );
    expect((JSON.parse(readFileSync(path, "utf8")) as { version: number }).version).toBe(1);
  });

  test("an ownerless lock directory younger than the claim grace stays a pending claim", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(dirOf(path));
    writeFileSync(path, JSON.stringify({ pid: 7004, at: NOW }));
    expect(acquirePluginLock(path, { alive: () => false, now: () => NOW })).toBe(false);
  });

  test("an old-format file with a missing tick recovers once its claim is old", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: NOW - 120_000 }));
    expect(acquirePluginLock(path, { now: () => NOW })).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  test("a missing tick with a fresh claim stays doubt", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: NOW }));
    expect(acquirePluginLock(path, { now: () => NOW })).toBe(false);
    expect(existsSync(dirOf(path))).toBe(false);
  });

  test("an old-format file whose pid was reused recovers once its tick is stale", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    writeFileSync(tickPath(path), JSON.stringify({ pid: process.ppid, at: NOW - 120_000 }));
    expect(acquirePluginLock(path, { now: () => NOW })).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
  });

  test("a live old-format holder with a fresh tick is still waited out", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    writeFileSync(tickPath(path), JSON.stringify({ pid: process.ppid, at: NOW - 1_000 }));
    expect(acquirePluginLock(path, { now: () => NOW })).toBe(false);
    expect(existsSync(dirOf(path))).toBe(false);
  });
});
