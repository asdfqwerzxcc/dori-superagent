import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insideLeadTree, launchOutOfTree, swapWorkerArgv, swapWorkerEnv } from "../src/lead-swap-detach.ts";
import { spawnExec } from "../src/runtime/exec.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
};
const until = async <T>(what: string, read: () => T | undefined, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

async function alive(pid: number): Promise<boolean> {
  const r = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`,
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const text = (await new Response(r.stdout).text()).trim();
  await r.exited;
  return text !== "0" && text !== "";
}

async function kill(pid: number): Promise<void> {
  const r = Bun.spawn(["taskkill", "/PID", String(pid), "/F"], {
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  await r.exited;
}

describe("the out-of-tree lead swap", () => {
  test("insideLeadTree follows parent pids", () => {
    const procs = [
      { pid: 1, parent: 0 },
      { pid: 2, parent: 1 },
      { pid: 3, parent: 2 },
      { pid: 4, parent: 3 },
    ];
    expect(insideLeadTree(procs, new Set([3]), 4)).toBe(true);
    expect(insideLeadTree(procs, new Set([4]), 4)).toBe(true);
    expect(insideLeadTree(procs, new Set([3]), 2)).toBe(false);
    expect(insideLeadTree(procs, new Set([1]), 4)).toBe(true);
    expect(insideLeadTree(procs, new Set([9]), 4)).toBe(false);
  });

  test("the worker environment is the minimal allowlist, never a DORI_/HERDR_ blanket", () => {
    const env = swapWorkerEnv(
      {
        DORI_HOME: "C:\\dori",
        DORI_HERDR_SESSION: "dori",
        DORI_RUNTIME: "hc",
        DORI_TELEMETRY: "0",
        DORI_TOKEN: "secret",
        HERDR_PANE_ID: "w1:p1",
        PATH: "C:\\bin",
        SECRET: "no",
        MULTI: "a\nb",
      },
      { DORI_AGENT_CMD: "omo" },
    );
    expect(env).toEqual({
      DORI_HOME: "C:\\dori",
      DORI_HERDR_SESSION: "dori",
      DORI_RUNTIME: "hc",
      DORI_TELEMETRY: "0",
      PATH: "C:\\bin",
      DORI_AGENT_CMD: "omo",
    });
  });

  test("the worker argv carries the resolved plan and no second delegation", () => {
    const argv = swapWorkerArgv(
      "bun",
      "C:\\dori\\cli.ts",
      {
        pane: { runtime: "herdr", id: "w1:p1" },
        session: "C:\\s.jsonl",
        prompt: "C:\\lead.md",
        command: "omo --session ...",
        target: [100],
        matched: [100, 200],
        drainMs: 5000,
        force: true,
      },
      "C:\\state\\ready",
      "C:\\state\\go",
      4242,
    );
    expect(argv).toEqual([
      "bun",
      "C:\\dori\\cli.ts",
      "lead-restart",
      "--swap-worker",
      "--pane",
      "w1:p1",
      "--session",
      "C:\\s.jsonl",
      "--drain-ms",
      "5000",
      "--force",
      "--prompt",
      "C:\\lead.md",
      "--marker",
      "C:\\state\\ready",
      "--go",
      "C:\\state\\go",
      "--parent-pid",
      "4242",
    ]);
  });

  test.skipIf(process.platform !== "win32")("the worker holds before its probe until go is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-handshake-"));
    const marker = join(dir, "ready.txt");
    const go = join(dir, "go.txt");
    let launched: { readonly pid: number; readonly go: () => void } | undefined;
    try {
      launched = await launchOutOfTree(spawnExec, {
        argv: [process.execPath, join(import.meta.dir, "fixtures/out-of-tree-handshake.ts"), dir, marker, go],
        env: {},
        cwd: process.cwd(),
        marker,
        go,
        launcherDir: dir,
      });
      await sleep(500);
      expect(existsSync(join(dir, "handshake-done.txt"))).toBe(false);
      launched.go();
      await until("the handshake worker to finish", () => readText(join(dir, "handshake-done.txt")));
    } finally {
      try {
        launched?.go();
      } catch {}
    }
  });

  test.skipIf(process.platform !== "win32")("the worker survives the lead's kill and finishes after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-detach-"));
    const lead = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/out-of-tree-lead.ts"), dir], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    let writerPid: number | undefined;
    try {
      await until("the swap to spawn its worker", () => readText(join(dir, "spawned.txt")));
      writerPid = await until("the writer's pid", () => {
        const text = readText(join(dir, "writer.pid"));
        return text === undefined || text === "" ? undefined : Number(text);
      });
      await until("the writer to pass the go gate", () => readText(join(dir, "writer-go-seen.txt")));
      expect(readText(join(dir, "swap-error.txt"))).toBeUndefined();
      const killLead = Bun.spawn(["taskkill", "/PID", String(lead.pid), "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
      await killLead.exited;
      expect(await alive(lead.pid)).toBe(false);
      expect(await alive(writerPid)).toBe(true);
      const controlAt = Date.now();
      writeFileSync(join(dir, "writer-control.txt"), "done");
      const done = join(dir, "writer-done.txt");
      await until("the writer to finish after the control file", () => (existsSync(done) ? true : undefined));
      expect(statSync(done).mtimeMs).toBeGreaterThanOrEqual(controlAt);
      expect(await alive(writerPid)).toBe(true);
    } finally {
      if (writerPid !== undefined) await kill(writerPid);
      if (await alive(lead.pid)) await kill(lead.pid);
    }
  });
});
