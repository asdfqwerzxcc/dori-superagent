import { join } from "node:path";
import type { CommandResult, DoctorEnv, RunCommand } from "../src/doctor-env.ts";

export const GIB = 1024 ** 3;
export const ok = (stdout = "", stderr = ""): CommandResult => ({ code: 0, stdout, stderr });
export const bad = (code = 127, stderr = "not found"): CommandResult => ({ code, stdout: "", stderr });

export type FakeDoctorOptions = {
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly online?: boolean;
  readonly commands?: Readonly<Record<string, CommandResult>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly dirs?: readonly string[];
  readonly writable?: boolean;
  readonly ports?: Readonly<Record<number, boolean | undefined>>;
  readonly diskFree?: number | "unknown";
  readonly totalMem?: number;
  readonly onRun?: (argv: readonly string[]) => void;
};

export const fakeDoctorEnv = (
  options: FakeDoctorOptions = {},
): { readonly env: DoctorEnv; readonly calls: string[][] } => {
  const homeDir = options.homeDir ?? join("/", "home", "me");
  const cwd = options.cwd ?? join("/", "work", "repo");
  const files = options.files ?? {};
  const dirs = new Set(options.dirs ?? []);
  const commands = options.commands ?? {};
  const calls: string[][] = [];
  const run: RunCommand = async (argv) => {
    calls.push([...argv]);
    options.onRun?.(argv);
    return commands[argv.join(" ")] ?? bad();
  };
  const env: DoctorEnv = {
    env: options.env ?? {},
    cwd,
    homeDir,
    online: options.online ?? false,
    run,
    readText: (path) => files[path],
    pathExists: (path) => dirs.has(path) || path in files,
    isDir: (path) => dirs.has(path),
    writable: () => options.writable ?? true,
    portOpen: async (port) => (options.ports !== undefined && port in options.ports ? options.ports[port] : false),
    diskFreeBytes: () => (options.diskFree === "unknown" ? undefined : (options.diskFree ?? 20 * GIB)),
    totalMemBytes: () => options.totalMem ?? 16 * GIB,
  };
  return { env, calls };
};
