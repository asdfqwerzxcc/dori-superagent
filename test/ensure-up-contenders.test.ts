import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinContenders, readContenders } from "../src/plugins/plugin.ts";
import { waitPluginLock } from "../src/plugins/run.ts";
import { isPluginEnabled, setPluginEnabled, writePluginsConfig } from "../src/plugins/state.ts";
import { processStartTimeMs, terminateProcess } from "../src/process-liveness.ts";

const NOW = 1_800_000_000_000;
const CONTENDER = 7004;

const homeWithState = (): string => {
  const home = mkdtempSync(join(tmpdir(), "dori-contender-"));
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
};

const contendersDir = (home: string, name = "ensure-up"): string =>
  join(home, "state", "plugins", `${name}.contenders`);

const contenderPath = (home: string, pid: number, name = "ensure-up"): string =>
  join(contendersDir(home, name), `${pid}.json`);

const lockPath = (home: string, name = "ensure-up"): string => {
  mkdirSync(join(home, "state", "plugins"), { recursive: true });
  return join(home, "state", "plugins", `${name}.lock`);
};

const holdLock = (home: string, pid = process.ppid): string => {
  const path = lockPath(home);
  const startedAt = processStartTimeMs(pid);
  writeFileSync(
    path,
    JSON.stringify({ version: 1, pid, at: Date.now(), ...(startedAt === null ? {} : { startedAt }) }),
  );
  return path;
};

const tickPath = (home: string, name = "ensure-up"): string => join(home, "state", "plugins", `${name}.tick`);

const dropLock = (lock: string): void => rmSync(lock, { force: true });

describe("the contender registry", () => {
  test("a contender file carries the pid and its OS start time", () => {
    const home = homeWithState();
    joinContenders(home, "ensure-up", process.ppid);
    const stored = JSON.parse(readFileSync(contenderPath(home, process.ppid), "utf8")) as {
      pid: number;
      at: number;
    };
    expect(stored.pid).toBe(process.ppid);
    expect(Number.isInteger(stored.at) && stored.at > 0).toBe(true);
    const injected = readContenders(home, "ensure-up", { same: () => true });
    expect(injected.map(({ pid, at }) => ({ pid, at }))).toEqual([stored]);
    expect(typeof injected[0]?.beat).toBe("number");
    const listed = readContenders(home, "ensure-up");
    expect(listed.map(({ pid, at }) => ({ pid, at }))).toEqual([stored]);
    expect(typeof listed[0]?.beat).toBe("number");
  });

  test("a pid without an OS start time is not recorded as a contender", () => {
    const home = homeWithState();
    joinContenders(home, "ensure-up", 7004, { started: () => null });
    expect(existsSync(contenderPath(home, 7004))).toBe(false);
  });

  test("a live pid whose start time differs is removed, never trusted", () => {
    const home = homeWithState();
    const path = contenderPath(home, CONTENDER);
    mkdirSync(contendersDir(home), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid: CONTENDER, at: NOW }));
    const calls: { pid: number; at: number }[] = [];
    const live = readContenders(home, "ensure-up", {
      same: (c) => {
        calls.push({ pid: c.pid, at: c.at });
        return false;
      },
      started: () => NOW + 60_000,
    });
    expect(live).toEqual([]);
    expect(calls).toEqual([{ pid: CONTENDER, at: NOW }]);
    expect(existsSync(path)).toBe(false);
  });

  test("another plugin's contenders do not leak into ensure-up", () => {
    const home = homeWithState();
    joinContenders(home, "other", process.ppid);
    expect(readContenders(home, "ensure-up")).toEqual([]);
    expect(readContenders(home, "other").map((c) => c.pid)).toEqual([process.ppid]);
  });

  test("a null start keeps the contender marker", () => {
    const home = homeWithState();
    mkdirSync(contendersDir(home), { recursive: true });
    const path = join(contendersDir(home), "7007.json");
    writeFileSync(path, JSON.stringify({ pid: 7007, at: NOW }));
    expect(readContenders(home, "ensure-up", { same: () => false, started: () => null })).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test("a directory or a malformed file is skipped, never thrown on", () => {
    const home = homeWithState();
    mkdirSync(join(contendersDir(home), "7005.json"), { recursive: true });
    writeFileSync(join(contendersDir(home), "7006.json"), "not json");
    expect(readContenders(home, "ensure-up", { same: () => true })).toEqual([]);
    // A parse failure may be a concurrent truncation: ignore it, never delete the live marker.
    expect(existsSync(join(contendersDir(home), "7006.json"))).toBe(true);
  });
});

describe("a plugin child that loses the lock", () => {
  test("retries and takes over once the holder goes", async () => {
    const home = homeWithState();
    const lock = holdLock(home);
    let sleeps = 0;
    const held = await waitPluginLock(home, "ensure-up", lock, {
      log: () => {},
      sleep: async () => {
        sleeps += 1;
        dropLock(lock);
      },
    });
    expect(held).toBe(true);
    expect(sleeps).toBeGreaterThan(0);
    expect((JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid: number }).pid).toBe(process.pid);
    expect(existsSync(contenderPath(home, process.pid))).toBe(false);
  });

  test("leaves the holder's tick alone and refreshes its own contender file", async () => {
    const home = homeWithState();
    const lock = holdLock(home);
    writeFileSync(tickPath(home), JSON.stringify({ pid: process.ppid, at: NOW }));
    let tickDuringWait: number | undefined;
    let contenderDuringWait = false;
    await waitPluginLock(home, "ensure-up", lock, {
      log: () => {},
      sleep: async () => {
        tickDuringWait = (JSON.parse(readFileSync(tickPath(home), "utf8")) as { pid: number }).pid;
        contenderDuringWait = existsSync(contenderPath(home, process.pid));
        dropLock(lock);
      },
    });
    expect(tickDuringWait).toBe(process.ppid);
    expect(contenderDuringWait).toBe(true);
  });

  test("an off loop's waiting duplicate stays and takes over when the holder goes", async () => {
    const home = homeWithState();
    const lock = holdLock(home);
    writeFileSync(join(home, "state", "ensure-up.off"), "");
    let sleeps = 0;
    const held = await waitPluginLock(home, "ensure-up", lock, {
      log: () => {},
      sleep: async () => {
        sleeps += 1;
        dropLock(lock);
      },
    });
    expect(held).toBe(true);
    expect(sleeps).toBe(1);
  });

  test("a child disabled while it waits leaves the lock and its marker", async () => {
    const home = homeWithState();
    const lock = holdLock(home);
    let sleeps = 0;
    const held = await waitPluginLock(home, "ensure-up", lock, {
      log: () => {},
      wanted: () => isPluginEnabled(home, "ensure-up"),
      sleep: async () => {
        sleeps += 1;
        writePluginsConfig(home, setPluginEnabled(home, "ensure-up", false));
      },
    });
    expect(held).toBe(false);
    expect(sleeps).toBe(1);
    expect(existsSync(contenderPath(home, process.pid))).toBe(false);
    expect((JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid).toBe(process.ppid);
  });

  test("a disabled plugin never takes the lock and clears a stale marker", async () => {
    const home = homeWithState();
    const lock = holdLock(home);
    writePluginsConfig(home, setPluginEnabled(home, "ensure-up", false));
    joinContenders(home, "ensure-up");
    const held = await waitPluginLock(home, "ensure-up", lock, {
      log: () => {},
      wanted: () => isPluginEnabled(home, "ensure-up"),
      sleep: async () => {},
    });
    expect(held).toBe(false);
    expect(existsSync(contenderPath(home, process.pid))).toBe(false);
  });

  test("records itself as a contender while it retries", async () => {
    const root = join(import.meta.dir, "..");
    const home = homeWithState();
    mkdirSync(contendersDir(home), { recursive: true });
    holdLock(home);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const appeared = Promise.withResolvers<void>();
    const watcher = watch(contendersDir(home), (_event, file) => {
      if (child !== undefined && String(file) === `${child.pid}.json`) appeared.resolve();
    });
    child = Bun.spawn([process.execPath, join(root, "src", "plugins", "run.ts"), "ensure-up"], {
      cwd: root,
      env: { ...process.env, DORI_HOME: home },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    try {
      await appeared.promise;
      const stored = JSON.parse(readFileSync(contenderPath(home, child.pid), "utf8")) as {
        pid: number;
        at: number;
      };
      expect(stored.pid).toBe(child.pid);
      expect(Number.isInteger(stored.at) && stored.at > 0).toBe(true);
      const listed = readContenders(home, "ensure-up");
      expect(listed.map(({ pid, at }) => ({ pid, at }))).toEqual([stored]);
      expect(typeof listed[0]?.beat).toBe("number");
    } finally {
      watcher.close();
      terminateProcess(child.pid);
      await child.exited;
    }
  });
});
