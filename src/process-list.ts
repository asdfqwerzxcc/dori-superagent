import { spawnExec, type Exec } from "./runtime/exec.ts";

/** A process the OS reports, with the command line `dori restart` matches against and its parent when the OS gives one. */
export type Proc = { readonly pid: number; readonly command: string; readonly parent?: number };

export const matchPids = (procs: readonly Proc[] | undefined, ...patterns: readonly string[]): number[] =>
  (procs ?? []).filter((p) => patterns.some((s) => p.command.includes(s))).map((p) => p.pid);

const WINDOWS_LIST =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'bun.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/** `ConvertTo-Json` output: one object when the OS found one bun, an array otherwise. */
export function parseCim(text: string): Proc[] {
  try {
    const parsed = JSON.parse(text.trim() || "[]") as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.flatMap((row) => {
      const r = (row ?? {}) as { ProcessId?: unknown; ParentProcessId?: unknown; CommandLine?: unknown };
      const pid = Number(r.ProcessId);
      if (!Number.isInteger(pid) || pid <= 0) return [];
      const parent = Number(r.ParentProcessId);
      return [
        {
          pid,
          command: String(r.CommandLine ?? ""),
          ...(Number.isInteger(parent) && parent > 0 ? { parent } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

/** `ps -A -o pid=,ppid=,args=` (or the older two-column form): pid, optional parent pid, then the command line. */
export function parsePs(text: string): Proc[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(?:(\d+)\s+)?(.*)$/.exec(line);
    if (m === null) return [];
    const parent = m[2] === undefined ? undefined : Number(m[2]);
    return [{ pid: Number(m[1]), command: m[3] ?? "", ...(parent === undefined ? {} : { parent }) }];
  });
}

/** Every bun process with its command line and parent; undefined when the OS query fails (liveness is then unknown). */
export async function listProcesses(exec: Exec = spawnExec): Promise<Proc[] | undefined> {
  const windows = process.platform === "win32";
  const r = windows
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LIST])
    : await exec("ps", ["-A", "-o", "pid=,ppid=,args="]);
  if (r.code !== 0) return undefined;
  return windows ? parseCim(r.stdout) : parsePs(r.stdout);
}
