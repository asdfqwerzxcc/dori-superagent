import { freemem, hostname, totalmem, uptime } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countLiveLanes } from "./link-store.ts";
import { Refusal } from "./refusal.ts";

export type LinkStatus = {
  host: string;
  os: string;
  arch: string;
  cpuPct: number | null;
  memFreePct: number | null;
  load: number | null;
  uptimeSec: number;
  sessions: number;
  doriVersion: string;
  now: string;
};

export type ExecResult = { code: number; stdout: string };
export type StatusProbe = {
  platform: NodeJS.Platform;
  arch: string;
  host: string;
  now: number;
  uptimeSec: number;
  readText: (path: string) => string;
  run: (cmd: string, argv: readonly string[]) => Promise<ExecResult>;
  pause: (ms: number) => Promise<void>;
  memFreePct: () => number;
  sessions: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, at: string, nullable: boolean): number | null => {
  if (v === null && nullable) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Refusal(`/status ${at} must be a number`);
  return v;
};

export const parseStatus = (raw: unknown): LinkStatus => {
  if (!isRecord(raw)) throw new Refusal("/status must be a JSON object");
  const text = (v: unknown, at: string): string => {
    if (typeof v !== "string" || v === "") throw new Refusal(`/status ${at} must be a non-empty string`);
    return v;
  };
  if (!Number.isInteger(raw["sessions"])) throw new Refusal("/status sessions must be an integer");
  return {
    host: text(raw["host"], "host"),
    os: text(raw["os"], "os"),
    arch: text(raw["arch"], "arch"),
    cpuPct: num(raw["cpuPct"], "cpuPct", true),
    memFreePct: num(raw["memFreePct"], "memFreePct", true),
    load: num(raw["load"], "load", true),
    uptimeSec: num(raw["uptimeSec"], "uptimeSec", false) ?? 0,
    sessions: raw["sessions"] as number,
    doriVersion: text(raw["doriVersion"], "doriVersion"),
    now: text(raw["now"], "now"),
  };
};

const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

const cpuFromProc = (before: string, after: string): number | null => {
  const fields = (source: string): number[] | null => {
    const line = source.split("\n").find((l) => l.startsWith("cpu "));
    if (line === undefined) return null;
    return line.trim().split(/\s+/).slice(1).map(Number);
  };
  const a = fields(before);
  const b = fields(after);
  if (a === null || b === null) return null;
  const sum = (v: readonly number[]): number => v.slice(0, 8).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  const idle = (v: readonly number[]): number => (v[3] ?? 0) + (v[4] ?? 0);
  const total = sum(b) - sum(a);
  if (total <= 0) return null;
  return clampPct((100 * (total - (idle(b) - idle(a)))) / total);
};

const memFromProc = (text: string): number | null => {
  const value = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text);
    return m === null ? undefined : Number(m[1]);
  };
  const available = value("MemAvailable");
  const total = value("MemTotal");
  return available === undefined || total === undefined || total === 0 ? null : clampPct((100 * available) / total);
};

const windowsScript =
  "$o=Get-CimInstance Win32_OperatingSystem;" +
  "$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;" +
  "[pscustomobject]@{cpu=$cpu;freeKB=[double]$o.FreePhysicalMemory;totalKB=[double]$o.TotalVisibleMemorySize;" +
  'boot=$o.LastBootUpTime.ToUniversalTime().ToString("o")} | ConvertTo-Json -Compress';

type WindowsSample = { cpu?: unknown; freeKB?: unknown; totalKB?: unknown; boot?: unknown };

const windowsStatus = (
  sample: WindowsSample,
  now: number,
): Pick<LinkStatus, "cpuPct" | "memFreePct" | "load" | "uptimeSec"> => {
  const cpu = typeof sample.cpu === "number" && Number.isFinite(sample.cpu) ? clampPct(sample.cpu) : null;
  const free = typeof sample.freeKB === "number" ? sample.freeKB : Number(sample.freeKB);
  const total = typeof sample.totalKB === "number" ? sample.totalKB : Number(sample.totalKB);
  const mem = Number.isFinite(free) && Number.isFinite(total) && total > 0 ? clampPct((100 * free) / total) : null;
  const boot = typeof sample.boot === "string" ? Date.parse(sample.boot) : Number.NaN;
  const uptimeSec = Number.isFinite(boot) ? Math.max(0, Math.round((now - boot) / 1000)) : 0;
  return { cpuPct: cpu, memFreePct: mem, load: null, uptimeSec };
};

const versionFile = join(import.meta.dir, "..", "package.json");
let versionCache: string | undefined;

export const doriVersion = (): string => {
  if (versionCache === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(versionFile, "utf8")) as { version?: unknown };
      versionCache = typeof pkg.version === "string" ? pkg.version : "unknown";
    } catch {
      versionCache = "unknown";
    }
  }
  return versionCache;
};

const linuxStatus = async (probe: StatusProbe): Promise<LinkStatus> => {
  const before = probe.readText("/proc/stat");
  await probe.pause(120);
  const after = probe.readText("/proc/stat");
  const loadText = probe.readText("/proc/loadavg").trim().split(/\s+/)[0];
  const load = loadText === undefined || !Number.isFinite(Number(loadText)) ? null : Number(loadText);
  let memFree: number | null = null;
  try {
    memFree = memFromProc(probe.readText("/proc/meminfo"));
  } catch {
    memFree = null;
  }
  let up = probe.uptimeSec;
  try {
    const first = probe.readText("/proc/uptime").trim().split(/\s+/)[0];
    if (first !== undefined && Number.isFinite(Number(first))) up = Math.round(Number(first));
  } catch {
    up = probe.uptimeSec;
  }
  return {
    host: probe.host,
    os: probe.platform,
    arch: probe.arch,
    cpuPct: cpuFromProc(before, after),
    memFreePct: memFree ?? clampPct(probe.memFreePct()),
    load,
    uptimeSec: Math.round(up),
    sessions: probe.sessions,
    doriVersion: doriVersion(),
    now: new Date(probe.now).toISOString(),
  };
};

export const collectStatus = async (probe: StatusProbe): Promise<LinkStatus> => {
  const base = {
    host: probe.host,
    os: probe.platform,
    arch: probe.arch,
    sessions: probe.sessions,
    doriVersion: doriVersion(),
    now: new Date(probe.now).toISOString(),
  };
  if (probe.platform === "win32") {
    try {
      const answer = await probe.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", windowsScript]);
      if (answer.code !== 0) throw new Refusal(answer.stdout || "powershell failed");
      const sample = JSON.parse(answer.stdout) as WindowsSample;
      const win = windowsStatus(sample, probe.now);
      const uptimeSec = win.uptimeSec > 0 ? win.uptimeSec : Math.round(probe.uptimeSec);
      return { ...base, ...win, uptimeSec };
    } catch {
      return {
        ...base,
        cpuPct: null,
        memFreePct: clampPct(probe.memFreePct()),
        load: null,
        uptimeSec: Math.round(probe.uptimeSec),
      };
    }
  }
  if (probe.platform === "linux") return linuxStatus(probe);
  return {
    ...base,
    cpuPct: null,
    memFreePct: clampPct(probe.memFreePct()),
    load: null,
    uptimeSec: Math.round(probe.uptimeSec),
  };
};

const runCommand = async (cmd: string, argv: readonly string[]): Promise<ExecResult> => {
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { code, stdout };
};

export const systemProbe = (home: string): StatusProbe => ({
  platform: process.platform,
  arch: process.arch,
  host: hostname(),
  now: Date.now(),
  uptimeSec: uptime(),
  readText: (path) => readFileSync(path, "utf8"),
  run: runCommand,
  pause: (ms) => Bun.sleep(ms),
  memFreePct: () => (freemem() / totalmem()) * 100,
  sessions: countLiveLanes(home),
});
