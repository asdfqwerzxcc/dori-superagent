// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/** The running child as `onSpawn` reports it: `pid` lets a later process kill its whole tree. */
export type SpawnedProcess = { readonly pid?: number; kill(): void };
/**
 * `onSpawn` gets the running process, so a caller that gives up on it can kill it. `onStdout`/`onStderr` receive output
 * as it arrives; the final result still carries the whole text. `group` starts the child as its own process group, so
 * killing the tree cannot reach this process. On Windows the child is also hidden, because a detached console opens a
 * terminal window that outlives it. `stdin` is fed to the child over a pipe, so a prompt can exceed the OS argv limit.
 */
export type ExecOptions = {
  readonly onSpawn?: (proc: SpawnedProcess) => void;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly group?: boolean;
  readonly stdin?: string;
};
export type Exec = (cmd: string, argv: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

/** Reads one pipe to the end, handing every decoded chunk to `sink` and returning the whole text. */
async function pump(stream: ReadableStream<Uint8Array>, sink?: (chunk: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      out += text;
      sink?.(text);
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

export const spawnExec: Exec = async (cmd, argv, options) => {
  const proc = Bun.spawn([cmd, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: options?.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    // A detached console child would otherwise get a Windows Terminal window of its own; hiding it keeps behavior.
    windowsHide: true,
    ...(options?.group === true ? { detached: true } : {}),
  });
  options?.onSpawn?.(proc);
  const [stdout, stderr, code] = await Promise.all([
    pump(proc.stdout, options?.onStdout),
    pump(proc.stderr, options?.onStderr),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** A runtime CLI call that exited non-zero; the message carries the tool, its argv and the tool's own reason. */
export class ToolError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: ExecResult,
    tool: string,
  ) {
    super(`${tool} ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}
