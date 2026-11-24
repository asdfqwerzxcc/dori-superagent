import type { Exec } from "./runtime/exec.ts";

/** A process with the command line the lead-stack matcher needs (pid, command, optional parent). */
export type Proc = { readonly pid: number; readonly command: string; readonly parent?: number };

/** `ConvertTo-Json` output: one object when the OS found one process, an array otherwise. */
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
    const m = /^\s*(\d+)\s+(?:([0-9]+)\s+)?(.*)$/.exec(line);
    if (m === null) return [];
    const parent = m[2] === undefined ? undefined : Number(m[2]);
    return [{ pid: Number(m[1]), command: m[3] ?? "", ...(parent === undefined ? {} : { parent }) }];
  });
}

const WINDOWS_ALL =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/**
 * Every process with its command line: the lead stack is identified by its command lines, which kernel32 does not
 * expose. This is the one remaining Get-CimInstance call, only on an explicit lead restart, and its exec is forced
 * hidden by spawnExec.
 */
export async function listAllProcesses(exec: Exec): Promise<Proc[] | undefined> {
  const windows = process.platform === "win32";
  const r = windows
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ALL])
    : await exec("ps", ["-A", "-o", "pid=,ppid=,args="]);
  if (r.code !== 0) return undefined;
  return windows ? parseCim(r.stdout) : parsePs(r.stdout);
}
