import { spawnExec, type Exec } from "./runtime/exec.ts";
import { win32Kernel } from "./win32-kernel.ts";

/** One OS process as the pane probe needs it: pid, parent pid and executable name (no command line is read). */
export type ProcNode = { readonly pid: number; readonly parent?: number; readonly exe: string };

const SNAPSHOT_PROCESSES = 0x0000_0002;
// PROCESSENTRY32W on 64-bit Windows: dwSize, cntUsage, th32ProcessID at 8, ULONG_PTR at 16, ... th32ParentProcessID at
// 32, dwFlags at 40, szExeFile (WCHAR[260]) at 44; the struct is 568 bytes with 8-byte alignment.
const ENTRY_BYTES = 568;
const PID_AT = 8;
const PARENT_AT = 32;
const EXE_AT = 44;
const EXE_BYTES = 520;
const utf16 = new TextDecoder("utf-16le");

/** A Toolhelp32 snapshot answers without spawning anything; undefined when the snapshot cannot be opened. */
function snapshotWindows(): ProcNode[] | undefined {
  const kernel = win32Kernel();
  if (kernel === undefined) return undefined;
  const snapshot = kernel.CreateToolhelp32Snapshot(SNAPSHOT_PROCESSES, 0);
  if (snapshot === null || snapshot === 0 || snapshot === -1) return undefined;
  const entry = new Uint8Array(ENTRY_BYTES);
  new DataView(entry.buffer).setUint32(0, ENTRY_BYTES, true);
  const nodes: ProcNode[] = [];
  let more = kernel.Process32FirstW(snapshot, entry) !== 0;
  while (more) {
    const view = new DataView(entry.buffer);
    const pid = view.getUint32(PID_AT, true);
    const parent = view.getUint32(PARENT_AT, true);
    const exe = utf16.decode(entry.subarray(EXE_AT, EXE_AT + EXE_BYTES)).split("\u0000")[0] ?? "";
    if (pid > 0) nodes.push({ pid, ...(parent > 0 ? { parent } : {}), exe });
    more = kernel.Process32NextW(snapshot, entry) !== 0;
  }
  kernel.CloseHandle(snapshot);
  return nodes;
}

/** "ps -A -o pid=,ppid=,comm=" rows: pid, parent pid, executable. */
export function parsePsTree(text: string): ProcNode[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) return [];
    return [{ pid: Number(m[1]), parent: Number(m[2]), exe: m[3]?.trim() ?? "" }];
  });
}

/**
 * Every process with its parent and executable. Windows reads the kernel's Toolhelp32 snapshot through FFI (no child
 * process); POSIX asks ps. `exec` is a test seam and is never called on Windows.
 */
export async function listProcessTree(exec: Exec = spawnExec): Promise<readonly ProcNode[] | undefined> {
  if (process.platform === "win32") return snapshotWindows();
  const r = await exec("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  return r.code === 0 ? parsePsTree(r.stdout) : undefined;
}

export const normalizeExe = (exe: string): string => {
  const base = exe.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
};

/** The pids directly under `shellPid` whose executable is bun: a pane runs exactly one unit that way. */
export function bunChildren(nodes: readonly ProcNode[], shellPid: number): number[] {
  return nodes.filter((n) => n.parent === shellPid && normalizeExe(n.exe) === "bun").map((n) => n.pid);
}
