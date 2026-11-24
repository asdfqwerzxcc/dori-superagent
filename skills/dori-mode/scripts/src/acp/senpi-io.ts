import { AcpError, LineFramer } from "./protocol.ts";
import { asError, snippet } from "./senpi-process.ts";
import type { SenpiChild } from "./senpi-types.ts";

export const spawnSenpi = (argv: readonly string[], cwd: string): SenpiChild => {
  try {
    return Bun.spawn([...argv], {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      ...(process.platform === "win32" ? {} : { detached: true }),
    }) as unknown as SenpiChild;
  } catch (error) {
    throw new AcpError(`could not start senpi: ${asError(error).message}`);
  }
};

export const readStdout = async (
  child: SenpiChild,
  framer: LineFramer,
  onLine: (line: string) => void,
  log: (line: string) => void,
  closed: () => boolean,
): Promise<void> => {
  const reader = child.stdout.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const line of framer.push(value)) onLine(line);
    }
    for (const line of framer.flush()) onLine(line);
  } catch (error) {
    if (!closed()) log(`senpi stdout read failed: ${asError(error).message}`);
  }
};

export const readStderr = async (
  child: SenpiChild,
  log: (line: string) => void,
  closed: () => boolean,
): Promise<void> => {
  const reader = child.stderr.getReader();
  const framer = new LineFramer();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const line of framer.push(value)) log(`senpi: ${snippet(line)}`);
    }
    for (const line of framer.flush()) log(`senpi: ${snippet(line)}`);
  } catch (error) {
    if (!closed()) log(`senpi stderr read failed: ${asError(error).message}`);
  }
};
