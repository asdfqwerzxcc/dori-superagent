import { SenpiBackend } from "./acp/backend.ts";
import { AcpError, LineFramer, type BackendFactory } from "./acp/protocol.ts";
import { AcpServer } from "./acp/server.ts";
import { loadConfig } from "./config.ts";

export { AcpError } from "./acp/protocol.ts";

export type RunAcpOptions = {
  readonly write?: (message: Record<string, unknown>) => void;
  readonly createBackend?: BackendFactory;
  readonly log?: (line: string) => void;
};

export const runAcp = async (options: RunAcpOptions = {}): Promise<void> => {
  const config = await loadConfig();
  const log = options.log ?? ((line: string) => process.stderr.write(`[dori-acp] ${line}\n`));
  const write =
    options.write ??
    ((message: Record<string, unknown>) => {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    });
  const createBackend =
    options.createBackend ??
    (async ({ cwd }: { readonly cwd: string }) => new SenpiBackend({ model: config.defaultModel, cwd, log }));
  const server = new AcpServer({ write, createBackend, log });
  const inflight = new Set<Promise<void>>();
  const track = (task: Promise<void>): void => {
    inflight.add(task);
    task.then(
      () => inflight.delete(task),
      () => inflight.delete(task),
    );
  };
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= (async () => {
      await server.shutdown();
      await Promise.allSettled([...inflight]);
    })();
    return shuttingDown;
  };
  const stop = (code: number): void => {
    void shutdown().then(
      () => process.exit(code),
      () => process.exit(code),
    );
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  if (!config.defaultModel.trim()) throw new AcpError("defaultModel is empty; set one in ~/.dori/config.json");
  const framer = new LineFramer();
  try {
    for await (const chunk of Bun.stdin.stream()) {
      for (const line of framer.push(chunk)) track(server.handleLine(line));
    }
    for (const line of framer.flush()) track(server.handleLine(line));
  } finally {
    await shutdown();
  }
};
