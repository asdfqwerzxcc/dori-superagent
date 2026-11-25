import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPluginLock } from "../src/plugins/plugin.ts";
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

const ownerPid = (path: string): number =>
  (JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid: number }).pid;

describe("the plugin lock", () => {
  test("a lock is held only by a pid whose recorded start time matches", () => {
    const held = homeWithState();
    const heldLock = lockPath(held);
    const startedAt = processStartTimeMs(process.ppid);
    writeFileSync(heldLock, JSON.stringify({ version: 1, pid: process.ppid, at: Date.now(), startedAt }));
    expect(acquirePluginLock(heldLock)).toBe(false);

    const stale = homeWithState();
    const staleLock = lockPath(stale);
    writeFileSync(staleLock, JSON.stringify({ version: 1, pid: process.ppid, at: Date.now(), startedAt: NOW }));
    expect(acquirePluginLock(staleLock)).toBe(true);
    expect(ownerPid(staleLock)).toBe(process.pid);
  });

  test("an unreadable start time is doubt, not a stale lock", () => {
    const raw = { version: 1, pid: 7004, at: 0, startedAt: NOW };
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => null })).toBe(true);
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => NOW + 60_000 })).toBe(false);
    expect(lockHeldByRecord(raw, { alive: () => true, started: () => NOW })).toBe(true);
    expect(lockHeldByRecord(raw, { alive: () => false, started: () => NOW })).toBe(false);
  });

  test("a version 1 lock with a null start time is doubt, not stale", () => {
    expect(lockHeldByRecord({ version: 1, pid: 7004, at: 0, startedAt: null }, { alive: () => true })).toBe(true);
  });

  test("a stale self-pid lock is taken over", () => {
    const home = homeWithState();
    const path = lockPath(home);
    const own = processStartTimeMs(process.pid);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, pid: process.pid, at: Date.now(), startedAt: (own ?? Date.now()) + 60_000 }),
    );
    expect(acquirePluginLock(path)).toBe(true);
    expect(ownerPid(path)).toBe(process.pid);
  });

  test("an old-format lock with a dead pid is taken over and a second contender cannot take the new one", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect(acquirePluginLock(path, { alive: () => false })).toBe(true);
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("an old-format lock with a live pid is doubt, not a takeover", () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect(acquirePluginLock(path, { alive: () => true })).toBe(false);
  });

  test("two contenders racing for a stale lock produce one holder", async () => {
    const home = homeWithState();
    const path = lockPath(home);
    writeFileSync(path, JSON.stringify({ version: 1, pid: 0, at: NOW, startedAt: NOW }));
    const script = `import { acquirePluginLock } from "./src/plugins/run.ts"; const ok = acquirePluginLock(${JSON.stringify(path)}); console.log(ok ? "yes" : "no"); if (ok) await Bun.sleep(1000);`;
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
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ version: 1, token: "stale", pid: 7003, at: 100, startedAt: 100 }),
    );
    const fresh = 7100;
    let swapped = false;
    const deps = {
      alive: (pid: number) => pid === 7003 || pid === fresh,
      started: (pid: number) => {
        if (pid !== 7003) return 200;
        // A claims after this process read the stale record, before its takeover rename.
        swapped = true;
        rmSync(path, { recursive: true, force: true });
        mkdirSync(path);
        writeFileSync(
          join(path, "owner.json"),
          JSON.stringify({ version: 1, token: "fresh", pid: fresh, at: 200, startedAt: 200 }),
        );
        return 50; // the stale record's start no longer matches
      },
    };
    expect(acquirePluginLock(path, deps)).toBe(false);
    expect(swapped).toBe(true);
    expect((JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid: number }).pid).toBe(fresh);
  });

  test("a claim writes a complete owner atomically", () => {
    const home = homeWithState();
    const path = lockPath(home);
    expect(acquirePluginLock(path)).toBe(true);
    const record = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as { pid: number; token: string };
    expect(record.pid).toBe(process.pid);
    expect(typeof record.token).toBe("string");
    expect(readdirSync(path).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a truncated owner with a live temp claimant is doubt, not absent", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), "{");
    writeFileSync(join(path, `.owner.${process.ppid}.abc.tmp`), "{");
    expect(readPluginLock(home, "ensure-up")).toEqual({ pid: process.ppid, at: 0, startedAt: null });
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("a claim whose write cannot read the start time still holds its own lock", () => {
    const home = homeWithState();
    const path = lockPath(home);
    const real = processStartTimeMs(process.pid) ?? 1;
    let calls = 0;
    const started = (): number | null => (calls++ === 0 ? null : real);
    expect(acquirePluginLock(path, { started })).toBe(true);
    expect(acquirePluginLock(path)).toBe(false);
  });

  test("the same lock protocol serves another plugin: live legacy is doubt, dead legacy is stale", () => {
    const home = homeWithState();
    mkdirSync(join(home, "state", "plugins"), { recursive: true });
    const path = join(home, "state", "plugins", "other.lock");
    writeFileSync(path, JSON.stringify({ pid: process.ppid, at: Date.now() }));
    expect(acquirePluginLock(path, { alive: () => true })).toBe(false);
    expect(acquirePluginLock(path, { alive: () => false })).toBe(true);
  });

  test("a release removes only this process's lock", () => {
    const home = homeWithState();
    const path = lockPath(home);
    mkdirSync(path);
    writeFileSync(join(path, "owner.json"), JSON.stringify({ version: 1, pid: process.ppid, at: Date.now() }));
    releaseLockIfOwner(path);
    expect(existsSync(path)).toBe(true);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        at: Date.now(),
        startedAt: processStartTimeMs(process.pid),
      }),
    );
    releaseLockIfOwner(path);
    expect(existsSync(path)).toBe(false);
  });
});
