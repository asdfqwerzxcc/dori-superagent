// One injectable process runner shared by every runtime adapter, so tests replace the runtime binary with a recorder
// and end-to-end tests point it at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/**
 * `onSpawn` gets the running process, so a caller that gives up on it can kill it. `onStdout`/`onStderr` receive output
 * as it arrives; the final result still carries the whole text.
 */
export type ExecOptions = {
  readonly onSpawn?: (proc: { kill(): void }) => void;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
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
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
