import type { LineFramer } from "./protocol.ts";
import { readStderr, readStdout, spawnSenpi } from "./senpi-io.ts";
import { asError, killProcessTree, resolveSenpiCommand } from "./senpi-process.ts";
import type { SenpiBackendOptions, SenpiChild } from "./senpi-types.ts";

export type SenpiChildHooks = {
  readonly onLine: (line: string) => void;
  readonly onExit: (child: SenpiChild, code: number, error?: Error) => void;
  readonly closed: () => boolean;
  readonly log: (line: string) => void;
};

/** Spawns the senpi RPC child and wires its stdout, stderr, and exit into the given hooks. */
export const startSenpiChild = (opts: SenpiBackendOptions, framer: LineFramer, hooks: SenpiChildHooks): SenpiChild => {
  const command = opts.command ?? resolveSenpiCommand();
  const args = ["--mode", "rpc", "--model", opts.model];
  if (opts.permissionPreset !== false) args.push("--permission-preset", opts.permissionPreset ?? "full-access");
  const child = spawnSenpi([...command, ...args], opts.cwd);
  hooks.log(`SENPI_CHILD pid=${child.pid}`);
  void readStdout(child, framer, hooks.onLine, hooks.log, hooks.closed);
  void readStderr(child, hooks.log, hooks.closed);
  child.exited.then(
    (code) => hooks.onExit(child, code),
    (error) => hooks.onExit(child, -1, asError(error)),
  );
  return child;
};

/** Ends stdin, kills the process tree, and waits briefly for the child to exit. */
export const shutdownSenpiChild = async (child: SenpiChild): Promise<void> => {
  try {
    child.stdin.end();
  } catch {}
  await Promise.race([child.exited.catch(() => 0), Bun.sleep(1_500)]);
  await killProcessTree(child.pid);
  await Promise.race([child.exited.catch(() => 0), Bun.sleep(3_000)]);
};
