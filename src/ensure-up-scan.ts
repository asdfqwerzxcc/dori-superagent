import { homedir } from "node:os";
import { join } from "node:path";
import { pluginRunEntry } from "./plugins/plugin.ts";
import { processStartTimeMs } from "./process-liveness.ts";
import { spawnExec, type Exec } from "./runtime/exec.ts";

export type ScannedEnsureUp = { readonly pid: number; readonly startedAt: number | null };

export type EnsureUpScanOptions = {
  /** Defaults to `DORI_HOME` or `~/.dori`, the same home the CLI uses. */
  readonly home?: string;
  /** Defaults to this checkout's `run.ts`. */
  readonly entry?: string;
  readonly exec?: Exec;
  readonly platform?: NodeJS.Platform;
  readonly started?: (pid: number) => number | null;
};

const parsePs = (text: string): { pid: number; command: string }[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), command: m[2] ?? "" }];
  });

/** Splits a Windows command line on whitespace outside double quotes; Node quotes each argument that needs it. */
export function parseWindowsArgv(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of command) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current !== "") out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}

const isBun = (exe: string): boolean => /(^|[\\/])bun(\.exe)?$/i.test(exe);

/**
 * The supervisor spawns exactly `[bun, <entry>, ensure-up]`. Requiring the same three argv tokens, in the same
 * positions, keeps a process that merely mentions the entry or the name in another argument out of the candidate list.
 */
export const isEnsureUpCommand = (tokens: readonly string[], entry: string): boolean =>
  tokens.length === 3 && isBun(tokens[0] ?? "") && tokens[1] === entry && tokens[2] === "ensure-up";

const scanWindows = async (exec: Exec, entry: string, started: (pid: number) => number | null) => {
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const list = await exec("powershell", ["-NoProfile", "-Command", script]);
  if (list.code !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(list.stdout) as unknown;
  } catch {
    return [];
  }
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId?: unknown; CommandLine?: unknown }[];
  const found: ScannedEnsureUp[] = [];
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    const command = typeof row.CommandLine === "string" ? row.CommandLine : "";
    if (!Number.isInteger(pid) || pid <= 0 || command === "") continue;
    if (pid === process.pid || pid === process.ppid) continue;
    if (!isEnsureUpCommand(parseWindowsArgv(command), entry)) continue;
    found.push({ pid, startedAt: started(pid) });
  }
  return found;
};

/**
 * Finds a live `run.ts ensure-up` child that no record names: the pre-upgrade idle duplicate. Windows reads the
 * Win32_Process command line (the environment is not exposed there); POSIX reads `ps` and also requires the process
 * environment to carry this home. The exact entry path identifies the checkout, so a process that only mentions the
 * entry in another argument is never a candidate.
 */
export async function scanEnsureUpProcesses(opts: EnsureUpScanOptions = {}): Promise<ScannedEnsureUp[]> {
  const home = opts.home ?? process.env["DORI_HOME"] ?? join(homedir(), ".dori");
  const entry = opts.entry ?? pluginRunEntry();
  const exec = opts.exec ?? spawnExec;
  const started = opts.started ?? processStartTimeMs;
  if ((opts.platform ?? process.platform) === "win32") return scanWindows(exec, entry, started);
  // `-ww` keeps a long command line whole; without it ps truncates the entry or the trailing ensure-up name.
  const list = await exec("ps", ["-ww", "-A", "-o", "pid=,command="]);
  if (list.code !== 0) return [];
  const homeToken = `DORI_HOME=${home}`;
  const found: ScannedEnsureUp[] = [];
  for (const row of parsePs(list.stdout)) {
    if (row.pid === process.pid || row.pid === process.ppid) continue;
    if (!isEnsureUpCommand(row.command.trim().split(/\s+/), entry)) continue;
    const env = await exec("ps", ["eww", "-p", String(row.pid)]);
    if (env.code !== 0 || !env.stdout.includes(homeToken)) continue;
    found.push({ pid: row.pid, startedAt: started(row.pid) });
  }
  return found;
}
