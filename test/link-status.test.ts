import { describe, expect, test } from "bun:test";
import { type LinkStatus, type StatusProbe, collectStatus, doriVersion, parseStatus } from "../src/link-status.ts";
import { Refusal } from "../src/refusal.ts";

const NOW = 1_700_000_000_000;

const proc: Record<string, string> = {
  "/proc/stat": "cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n",
  "/proc/meminfo": "MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    250 kB\n",
  "/proc/loadavg": "0.42 0.10 0.05 1/100 123\n",
  "/proc/uptime": "12345.67 98765.43\n",
};

const calls: string[] = [];
const readProc = (path: string): string => {
  calls.push(path);
  const text = proc[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

const linuxProbe = (over: Partial<StatusProbe> = {}): StatusProbe => {
  calls.length = 0;
  let reads = 0;
  return {
    platform: "linux",
    arch: "x64",
    host: "box2",
    now: NOW,
    uptimeSec: 99,
    readText: (path) => {
      if (path === "/proc/stat") {
        reads += 1;
        return reads === 1 ? (proc["/proc/stat"] ?? "") : "cpu  200 0 200 1400 0 0 0 0 0 0\n";
      }
      return readProc(path);
    },
    run: async () => ({ code: 0, stdout: "{}" }),
    pause: async () => {},
    memFreePct: () => 50,
    sessions: 2,
    ...over,
  };
};

const valid: LinkStatus = {
  host: "box2",
  os: "linux",
  arch: "x64",
  cpuPct: 25,
  memFreePct: 25,
  load: 0.42,
  uptimeSec: 12_346,
  sessions: 2,
  doriVersion: "0.1.0",
  now: new Date(NOW).toISOString(),
};

describe("linux status", () => {
  test("cpu, memory, load and uptime come from /proc", async () => {
    const status = await collectStatus(linuxProbe());
    expect(status).toEqual(valid);
  });

  test("a missing /proc file leaves the field null instead of failing the whole answer", async () => {
    const probe = linuxProbe({
      readText: (path) => {
        if (path === "/proc/stat") return "cpu  1 0 1 8 0 0 0 0 0 0\n";
        if (path === "/proc/meminfo") throw new Error("no meminfo");
        return readProc(path);
      },
    });
    const status = await collectStatus(probe);
    expect(status.cpuPct).toBeNull();
    expect(status.memFreePct).toBe(50);
    expect(status.load).toBe(0.42);
  });
});

describe("windows status", () => {
  test("the powershell sample becomes cpu, memory and uptime without a load average", async () => {
    const boot = new Date(NOW - 3_600_000).toISOString();
    const status = await collectStatus({
      ...linuxProbe({ platform: "win32", uptimeSec: 77, sessions: 4 }),
      run: async (cmd, argv) => {
        expect(cmd).toBe("powershell");
        expect(argv).toContain("-NoProfile");
        return { code: 0, stdout: JSON.stringify({ cpu: 37, freeKB: 2000, totalKB: 8000, boot }) };
      },
    });
    expect(status).toMatchObject({ os: "win32", cpuPct: 37, memFreePct: 25, load: null, uptimeSec: 3600, sessions: 4 });
  });

  test("a failed powershell still answers with what node knows", async () => {
    const status = await collectStatus({
      ...linuxProbe({ platform: "win32", uptimeSec: 77 }),
      run: async () => ({ code: 1, stdout: "denied" }),
    });
    expect(status).toMatchObject({ cpuPct: null, memFreePct: 50, load: null, uptimeSec: 77 });
  });
});

describe("payload", () => {
  test("a good payload parses back field for field", () => {
    expect(parseStatus(valid)).toEqual(valid);
    expect(parseStatus({ ...valid, cpuPct: null, load: null }).cpuPct).toBeNull();
  });

  test("a payload with a missing or mistyped field is refused", () => {
    for (const bad of [
      { ...valid, host: "" },
      { ...valid, sessions: "2" },
      { ...valid, cpuPct: "25" },
      { ...valid, now: undefined },
      { ...valid, doriVersion: 1 },
      null,
      [],
    ])
      expect(() => parseStatus(bad)).toThrow(Refusal);
  });

  test("the version comes from this package", () => {
    expect(doriVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
