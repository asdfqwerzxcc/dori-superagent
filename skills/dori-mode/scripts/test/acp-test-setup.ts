import { join } from "node:path";

import { AcpServer } from "../src/acp/server.ts";
import type { Backend, StopReason } from "../src/acp/protocol.ts";

export type FakeState = {
  cancelCalls: number;
  closeCalls: number;
  prompts: string[];
  cancelled: boolean;
};

export type FakeOptions = {
  readonly text?: string;
  readonly waitForCancel?: boolean;
  readonly fail?: boolean;
};

export const fakeBackend = (opts: FakeOptions = {}) => {
  const state: FakeState = { cancelCalls: 0, closeCalls: 0, prompts: [], cancelled: false };
  let release: ((stop: StopReason) => void) | undefined;
  let started: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const backend: Backend = {
    prompt: async (text, onText) => {
      state.prompts.push(text);
      started?.();
      if (opts.fail) throw new Error("backend failed");
      if (opts.waitForCancel) {
        onText("working");
        return new Promise<StopReason>((resolve) => {
          release = resolve;
        });
      }
      onText(opts.text ?? "DORI_ACP_OK");
      return "end_turn";
    },
    cancel: async () => {
      state.cancelCalls += 1;
      state.cancelled = true;
      release?.("cancelled");
    },
    close: async () => {
      state.closeCalls += 1;
      release?.("cancelled");
    },
  };
  return { backend, state, began };
};

export type Wire = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
};

export type ResultFields = {
  readonly protocolVersion?: unknown;
  readonly agentInfo?: unknown;
  readonly agentCapabilities?: unknown;
  readonly authMethods?: unknown;
  readonly sessionId?: unknown;
  readonly stopReason?: unknown;
};

export const collector = (backend: Backend) => {
  const messages: Wire[] = [];
  const server = new AcpServer({
    write: (message) => messages.push(message),
    createBackend: async () => backend,
    log: () => undefined,
  });
  const send = async (message: Record<string, unknown>): Promise<void> => {
    await server.handleLine(JSON.stringify({ jsonrpc: "2.0", ...message }));
  };
  return { messages, server, send };
};

export const response = (messages: Wire[], id: number): Wire | undefined =>
  messages.find((message) => message.id === id);

export const resultOf = (messages: Wire[], id: number): ResultFields =>
  (response(messages, id)?.result ?? {}) as ResultFields;

export const errorOf = (messages: Wire[], id: number): { readonly code?: unknown } =>
  (response(messages, id)?.error ?? {}) as { readonly code?: unknown };

export const newSession = async (
  send: (message: Record<string, unknown>) => Promise<void>,
  messages: Wire[],
  id: number,
): Promise<string> => {
  await send({ id, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
  return String(resultOf(messages, id).sessionId);
};

export const fakeChild = (): string => join(import.meta.dir, "fixtures/fake-senpi.ts");
