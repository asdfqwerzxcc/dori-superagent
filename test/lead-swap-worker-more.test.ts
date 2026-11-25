import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const worker = (extra: (paths: { sessionA: string; sessionB: string }) => string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "dori-worker-more-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "herdr.cmd"), "@echo off\r\necho pane_not_found 1>&2\r\nexit /b 1\r\n");
  const marker = join(dir, "ready.txt");
  const go = join(dir, "go.txt");
  const sessionA = join(home, "a.jsonl");
  const sessionB = join(home, "b.jsonl");
  writeFileSync(sessionA, '{"type":"session"}\n');
  writeFileSync(sessionB, '{"type":"session"}\n');
  const p = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "cli.ts"),
      "lead-restart",
      ...extra({ sessionA, sessionB }),
      "--swap-worker",
      "--pane",
      "w1:p1",
      "--marker",
      marker,
      "--go",
      go,
    ],
    {
      env: {
        ...process.env,
        DORI_HOME: home,
        DORI_RUNTIME: "herdr",
        DORI_HERDR_SESSION: "no-such-session",
        DORI_TELEMETRY: "0",
        PATH: `${bin};${process.env["PATH"] ?? ""}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  );
  return { dir, home, marker, go, sessionA, sessionB, p, stdout: new Response(p.stdout).text() };
};

describe.skipIf(process.platform !== "win32")("the lead-swap worker edge paths", () => {
  test("a go cleanup failure is logged and does not stop the worker", async () => {
    const w = worker(() => ["--session", "ignored"]);
    try {
      await until("the worker marker", () => (existsSync(w.marker) ? true : undefined));
      mkdirSync(w.go, { recursive: true });
      const code = await Promise.race([w.p.exited, sleep(8000).then(() => "timeout" as const)]);
      expect(code).not.toBe("timeout");
      expect(code).not.toBe(0);
      expect(await w.stdout).toContain("worker=1 pid=");
      const log = readFileSync(join(w.home, "state", "lead-restart.log"), "utf8");
      expect(log).toContain("WARN go file not removed");
      expect(log).not.toContain("LEADSWAP killed");
    } finally {
      try {
        w.p.kill();
      } catch {}
    }
  });

  test("a positional session wins over --session", async () => {
    const w = worker(({ sessionA, sessionB }) => [sessionA, "--session", sessionB]);
    try {
      await until("the worker marker", () => (existsSync(w.marker) ? true : undefined));
      writeFileSync(w.go, "go");
      await until("the worker to consume go", () => (existsSync(w.go) ? undefined : true));
      const [out, code] = await Promise.all([w.stdout, w.p.exited]);
      expect(code).not.toBe(0);
      expect(out).toContain(`session=${w.sessionA}`);
      expect(out).not.toContain(`session=${w.sessionB}`);
    } finally {
      try {
        w.p.kill();
      } catch {}
    }
  });
});
