import { accessSync, constants, existsSync, readFileSync, statfsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { homedir, totalmem } from "node:os";

/**
 * Everything `dori doctor` may touch, behind one injectable surface. The default reads this machine; a test supplies
 * a fake and the checks never look at the real PATH, filesystem, ports or memory.
 */
export type CommandResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type RunCommand = (
  argv: readonly string[],
  opts?: { readonly cwd?: string; readonly timeoutMs?: number },
) => Promise<CommandResult>;

export type DoctorEnv = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly homeDir: string;
  /** `--online`: the only mode in which a check may reach a remote service (gh/glab auth status). */
  readonly online: boolean;
  readonly run: RunCommand;
  readonly readText: (path: string) => string | undefined;
  readonly pathExists: (path: string) => boolean;
  readonly isDir: (path: string) => boolean;
  readonly writable: (path: string) => boolean;
  /** true = something is listening on 127.0.0.1:<port>; undefined = the probe could not tell. */
  readonly portOpen: (port: number) => Promise<boolean | undefined>;
  readonly diskFreeBytes: (path: string) => number | undefined;
  readonly totalMemBytes: () => number;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs one local command; a missing binary is a result (-1), never a thrown check. */
const runCommand: RunCommand = async (argv, opts = {}) => {
  try {
    const proc = Bun.spawn([...argv], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(opts.timeoutMs) }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited.catch(() => -1),
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: messageOf(e) };
  }
};

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const writable = (path: string): boolean => {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** A loopback connect: a listener accepts at once, a closed port refuses, and anything else is unknown. */
const portOpen = (port: number, timeoutMs = 400): Promise<boolean | undefined> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value: boolean | undefined) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(undefined));
    socket.once("error", (e) => finish((e as { code?: string }).code === "ECONNREFUSED" ? false : undefined));
  });

const diskFreeBytes = (path: string): number | undefined => {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
};

export const defaultDoctorEnv = (online: boolean): DoctorEnv => ({
  env: process.env,
  cwd: process.cwd(),
  homeDir: homedir(),
  online,
  run: runCommand,
  readText,
  pathExists: existsSync,
  isDir,
  writable,
  portOpen,
  diskFreeBytes,
  totalMemBytes: totalmem,
});
