import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock, readPidLock, releasePidLock } from "../src/pid-lock.ts";

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), "dori-lock-")), "supervisor.lock");

describe("recorded pid lock", () => {
  test("a free path is taken once and released", () => {
    const path = lockPath();
    expect(acquirePidLock(path)).toBe(true);
    expect(readPidLock(path)).toBe(process.pid);
    releasePidLock(path);
    expect(existsSync(path)).toBe(false);
  });

  test("a live holder refuses, and a dead holder's lock is taken over", () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 4242, at: 1 }));
    expect(acquirePidLock(path, (pid) => pid === 4242)).toBe(false);
    expect(readPidLock(path)).toBe(4242);
    expect(acquirePidLock(path, () => false)).toBe(true);
    expect(readPidLock(path)).toBe(process.pid);
  });

  test("an unreadable lock is replaced", () => {
    const path = lockPath();
    writeFileSync(path, "not json");
    expect(acquirePidLock(path, () => true)).toBe(true);
    expect(readPidLock(path)).toBe(process.pid);
  });
});
