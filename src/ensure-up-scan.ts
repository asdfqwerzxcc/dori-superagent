import { processStartTimeMs } from "./process-liveness.ts";
import { spawnExec, type Exec } from "./runtime/exec.ts";

export type ScannedEnsureUp = { readonly pid: number; readonly startedAt: number | null };

export type EnsureUpScanOptions = {
  readonly home: string;
  readonly entry: string;
  readonly exec?: Exec;
  readonly platform?: NodeJS.Platform;
  readonly started?: (pid: number) => number | null;
};

const parsePs = (text: string): { pid: number; command: string }[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), command: m[2] ?? "" }];
  });

/**
 * Finds a live `run.ts <name>` child that no record names: the pre-upgrade idle duplicate. The command must name this
 * exact entry and the process environment must carry this home, so another home's loop is never a candidate. Windows
 * returns none: a supervisor's children exit with it there (the platform note in docs/supervision.md), so the orphan
 * class this scan answers is POSIX-only. A process that cannot read its command or environment is simply not found.
 */
export async function scanEnsureUpProcesses(opts: EnsureUpScanOptions): Promise<ScannedEnsureUp[]> {
  if ((opts.platform ?? process.platform) === "win32") return [];
  const exec = opts.exec ?? spawnExec;
  const list = await exec("ps", ["-A", "-o", "pid=,command="]);
  if (list.code !== 0) return [];
  const homeToken = `DORI_HOME=${opts.home}`;
  const found: ScannedEnsureUp[] = [];
  for (const row of parsePs(list.stdout)) {
    if (row.pid === process.pid || row.pid === process.ppid) continue;
    if (!row.command.includes(opts.entry) || !/(^|\s)ensure-up(\s|$)/.test(row.command)) continue;
    const env = await exec("ps", ["eww", "-p", String(row.pid)]);
    if (env.code !== 0 || !env.stdout.includes(homeToken)) continue;
    found.push({ pid: row.pid, startedAt: (opts.started ?? processStartTimeMs)(row.pid) });
  }
  return found;
}
