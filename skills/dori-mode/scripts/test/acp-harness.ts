import { join } from "node:path";

import { LineFramer } from "../src/acp/protocol.ts";

export type AcpMessage = Record<string, unknown>;

type Waiter = {
  readonly predicate: (message: AcpMessage) => boolean;
  readonly resolve: (message: AcpMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type StderrWaiter = {
  readonly predicate: (text: string) => boolean;
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const repoRoot = join(import.meta.dir, "..");

export const startAcp = (env: Record<string, string>) => {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", "acp"], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const messages: AcpMessage[] = [];
  const waiters: Waiter[] = [];
  const stderrWaiters: StderrWaiter[] = [];
  let stderrText = "";
  let closed = false;
  const framer = new LineFramer();

  const deliver = (message: AcpMessage): void => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(i, 1);
      waiter.resolve(message);
    }
  };

  const failWaiters = (error: Error): void => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    for (const waiter of stderrWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const readStdout = async (): Promise<void> => {
    const reader = proc.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of framer.push(value)) {
          let message: AcpMessage;
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== "object" || parsed === null) continue;
            message = parsed as AcpMessage;
          } catch {
            continue;
          }
          deliver(message);
        }
      }
    } catch (error) {
      failWaiters(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const readStderr = async (): Promise<void> => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        stderrText += decoder.decode(value, { stream: true });
        for (let i = stderrWaiters.length - 1; i >= 0; i -= 1) {
          const waiter = stderrWaiters[i];
          if (!waiter || !waiter.predicate(stderrText)) continue;
          clearTimeout(waiter.timer);
          stderrWaiters.splice(i, 1);
          waiter.resolve(stderrText);
        }
      }
    } catch (error) {
      failWaiters(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const pump = Promise.all([readStdout(), readStderr()]);
  const send = (message: AcpMessage): void => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    void proc.stdin.flush();
  };
  const waitFor = (predicate: (message: AcpMessage) => boolean, timeoutMs = 10_000): Promise<AcpMessage> => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<AcpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for an ACP message; saw ${JSON.stringify(messages).slice(0, 1200)}; stderr ${stderrText.slice(0, 800)}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };
  const waitForStderr = (predicate: (text: string) => boolean, timeoutMs = 10_000): Promise<string> => {
    if (predicate(stderrText)) return Promise.resolve(stderrText);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = stderrWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) stderrWaiters.splice(index, 1);
        reject(new Error(`timed out waiting for stderr; saw ${stderrText.slice(0, 1200)}`));
      }, timeoutMs);
      stderrWaiters.push({ predicate, resolve, reject, timer });
    });
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      proc.stdin.end();
    } catch {}
    await Promise.race([proc.exited.catch(() => 0), Bun.sleep(2_000)]);
    try {
      proc.kill();
    } catch {}
    await Promise.race([proc.exited.catch(() => 0), Bun.sleep(2_000)]);
    await pump.catch(() => undefined);
    failWaiters(new Error("ACP process closed"));
  };
  return { proc, messages, send, waitFor, waitForStderr, stderr: () => stderrText, close };
};

export const processList = async (pid: number): Promise<string> => {
  const argv = process.platform === "win32" ? ["tasklist", "/FI", `PID eq ${pid}`] : ["ps", "-p", String(pid)];
  const result = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  return `exit=${code} ${out}${err}`.trim();
};

export const streamedText = (messages: readonly AcpMessage[]): string =>
  messages
    .filter((message) => message.method === "session/update")
    .map((message) => {
      const params = message.params as Record<string, unknown>;
      const update = params.update as Record<string, unknown>;
      const content = update.content as Record<string, unknown>;
      return typeof content.text === "string" ? content.text : "";
    })
    .join("");
