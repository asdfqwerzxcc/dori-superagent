import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchOutOfTree, swapWorkerEnv } from "../src/lead-swap-detach.ts";
import { markLeadRestartBusy } from "../src/lead-restart-busy.ts";
import type { Exec } from "../src/runtime/exec.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(what: string, read: () => T | undefined, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const ps1 = (dir: string): string[] => readdirSync(dir).filter((name) => name.endsWith(".ps1"));

describe("the lead-swap worker launcher", () => {
  test("a launch that never becomes ready leaves no plaintext launcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-launcher-"));
    const marker = join(dir, "ready.txt");
    const go = join(dir, "go.txt");
    let launcherText = "";
    const calls: string[][] = [];
    const exec: Exec = async (cmd, argv) => {
      calls.push([cmd, ...argv]);
      const name = ps1(dir)[0];
      if (name !== undefined) launcherText = readFileSync(join(dir, name), "utf8");
      return { code: 0, stdout: "PID=12345", stderr: "" };
    };
    const env = swapWorkerEnv(
      {
        DORI_HOME: "C:\\dori",
        DORI_RUNTIME: "hc",
        DORI_TELEMETRY: "0",
        DORI_TOKEN: "secret",
        PATH: "C:\\bin",
      },
      { DORI_AGENT_CMD: "omo" },
    );
    await expect(
      launchOutOfTree(exec, {
        argv: ["bun", "worker.ts"],
        env,
        cwd: dir,
        marker,
        go,
        launcherDir: dir,
        readyMs: 150,
        identity: () => true,
      }),
    ).rejects.toThrow("did not report ready");
    expect(launcherText).toContain("DORI_HOME");
    expect(launcherText).toContain("DORI_RUNTIME");
    expect(launcherText).toContain("DORI_TELEMETRY");
    expect(launcherText).not.toContain("DORI_TOKEN");
    expect(ps1(dir)).toEqual([]);
    expect(calls.some((c) => c[0] === "taskkill" && c.includes("12345") && c.includes("/T"))).toBe(true);
  });

  test("a WMI refusal leaves no launcher either", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-launcher-"));
    const exec: Exec = async () => ({ code: 1, stdout: "RET=9", stderr: "refused" });
    await expect(
      launchOutOfTree(exec, {
        argv: ["bun", "worker.ts"],
        env: swapWorkerEnv({ DORI_HOME: "C:\\dori" }, {}),
        cwd: dir,
        marker: join(dir, "ready.txt"),
        go: join(dir, "go.txt"),
        launcherDir: dir,
        readyMs: 150,
      }),
    ).rejects.toThrow("Win32_Process.Create failed");
    expect(ps1(dir)).toEqual([]);
  });

  test("a ready timeout does not kill a pid whose launcher identity is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-launcher-"));
    const calls: string[][] = [];
    const exec: Exec = async (cmd, argv) => {
      calls.push([cmd, ...argv]);
      return { code: 0, stdout: "PID=12345", stderr: "" };
    };
    await expect(
      launchOutOfTree(exec, {
        argv: ["bun", "worker.ts"],
        env: swapWorkerEnv({ DORI_HOME: "C:\\dori" }, {}),
        cwd: dir,
        marker: join(dir, "ready.txt"),
        go: join(dir, "go.txt"),
        launcherDir: dir,
        readyMs: 150,
        identity: () => false,
      }),
    ).rejects.toThrow("did not report ready");
    expect(calls.some((c) => c[0] === "taskkill")).toBe(false);
    expect(ps1(dir)).toEqual([]);
  });

  test.skipIf(process.platform !== "win32")(
    "the real CLI worker holds for go, consumes it, and logs worker=1",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dori-cli-worker-"));
      const fakeHerdr = join(dir, "bin");
      const home = join(dir, "home");
      mkdirSync(fakeHerdr, { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(fakeHerdr, "herdr.cmd"), "@echo off\r\necho pane_not_found 1>&2\r\nexit /b 1\r\n");
      const marker = join(dir, "ready.txt");
      const go = join(dir, "go.txt");
      const session = join(home, "session.jsonl");
      writeFileSync(session, '{"type":"session"}\n');
      const p = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "..", "src", "cli.ts"),
          "lead-restart",
          "--swap-worker",
          "--pane",
          "w1:p1",
          "--session",
          session,
          "--marker",
          marker,
          "--go",
          go,
          "--go-timeout-ms",
          "5000",
        ],
        {
          env: {
            ...process.env,
            DORI_HOME: home,
            DORI_RUNTIME: "herdr",
            DORI_HERDR_SESSION: "no-such-session",
            DORI_TELEMETRY: "0",
            PATH: `${fakeHerdr};${process.env["PATH"] ?? ""}`,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      );
      const stdout = new Response(p.stdout).text();
      const stderr = new Response(p.stderr).text();
      await until("the worker marker", () => (existsSync(marker) ? true : undefined));
      await sleep(250);
      expect(existsSync(go)).toBe(false);
      expect(p.exitCode).toBeNull();
      writeFileSync(go, "go");
      await until("the worker to consume go", () => (existsSync(go) ? undefined : true));
      const [out, err, code] = await Promise.all([stdout, stderr, p.exited]);
      expect(code).not.toBe(0);
      expect(out).toContain("worker=1 pid=");
      expect(err).not.toContain("usage");
      expect(existsSync(join(home, "state", "lead-restart.busy"))).toBe(false);
    },
  );

  test.skipIf(process.platform !== "win32")("the real CLI worker proceeds after the go timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dori-cli-worker-"));
    const home = join(dir, "home");
    const fakeHerdr = join(dir, "bin");
    mkdirSync(fakeHerdr, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(fakeHerdr, "herdr.cmd"), "@echo off\r\necho pane_not_found 1>&2\r\nexit /b 1\r\n");
    const marker = join(dir, "ready.txt");
    const go = join(dir, "go.txt");
    const session = join(home, "session.jsonl");
    writeFileSync(session, '{"type":"session"}\n');
    const parentToken = markLeadRestartBusy(home, "w1:p1", 60_000);
    expect(parentToken).toBeDefined();
    const p = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "cli.ts"),
        "lead-restart",
        "--swap-worker",
        "--pane",
        "w1:p1",
        "--session",
        session,
        "--marker",
        marker,
        "--go",
        go,
        "--go-timeout-ms",
        "250",
        "--busy-token",
        parentToken!,
      ],
      {
        env: {
          ...process.env,
          DORI_HOME: home,
          DORI_RUNTIME: "herdr",
          DORI_HERDR_SESSION: "no-such-session",
          DORI_TELEMETRY: "0",
          PATH: `${fakeHerdr};${process.env["PATH"] ?? ""}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    const stdout = new Response(p.stdout).text();
    const code = await Promise.race([p.exited, sleep(8000).then(() => "timeout" as const)]);
    expect(code).not.toBe("timeout");
    expect(code).toBe(2);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(go)).toBe(false);
    expect(existsSync(join(home, "state", "lead-restart.busy"))).toBe(false);
    const log = readFileSync(join(home, "state", "lead-restart.log"), "utf8");
    expect(log).toContain("worker aborted: go timeout");
    expect(log).not.toContain("LEADSWAP killed");
    expect(log).not.toContain("RESTARTED");
    expect(await stdout).toBe("");
  });
});
