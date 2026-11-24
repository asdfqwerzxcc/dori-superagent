import { dlopen, FFIType } from "bun:ffi";

/**
 * The kernel32 calls the supervisor needs. Each replaces a console-app spawn: a status read must not open a window, and
 * on a Windows Terminal host a non-hidden console child is a new visible tab.
 */
export type Win32Kernel = {
  readonly OpenProcess: (access: number, inherit: number, pid: number) => number | null;
  readonly CloseHandle: (handle: number) => number;
  readonly GetLastError: () => number;
  readonly GetExitCodeProcess: (handle: number, exitCode: Uint32Array) => number;
  readonly TerminateProcess: (handle: number, code: number) => number;
  readonly GetProcessTimes: (
    handle: number,
    creation: BigUint64Array,
    exit: BigUint64Array,
    kernelTime: BigUint64Array,
    user: BigUint64Array,
  ) => number;
  readonly CreateToolhelp32Snapshot: (flags: number, pid: number) => number | null;
  readonly Process32FirstW: (snapshot: number, entry: Uint8Array) => number;
  readonly Process32NextW: (snapshot: number, entry: Uint8Array) => number;
};

let loaded: Win32Kernel | null | undefined;

/** kernel32 on Windows, or undefined where it does not exist or cannot be loaded (POSIX keeps its own syscalls). */
export function win32Kernel(): Win32Kernel | undefined {
  if (process.platform !== "win32") return undefined;
  if (loaded !== undefined) return loaded ?? undefined;
  try {
    const lib = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      GetProcessTimes: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    loaded = lib.symbols as unknown as Win32Kernel;
  } catch {
    loaded = null;
  }
  return loaded ?? undefined;
}
