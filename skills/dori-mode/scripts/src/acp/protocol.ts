export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = string | number | null;

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type ContentBlock = {
  readonly type?: unknown;
  readonly text?: unknown;
};

export type PromptParams = {
  readonly sessionId?: unknown;
  readonly prompt?: unknown;
};

export type SessionParams = {
  readonly sessionId?: unknown;
};

export type NewSessionParams = {
  readonly cwd?: unknown;
  readonly mcpServers?: unknown;
  readonly additionalDirectories?: unknown;
};

export type InitializeParams = {
  readonly protocolVersion?: unknown;
  readonly clientCapabilities?: unknown;
  readonly clientInfo?: unknown;
};

export interface Backend {
  readonly pid?: number | undefined;
  prompt(text: string, onText: (text: string) => void): Promise<StopReason>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type BackendFactory = (input: { readonly cwd: string }) => Promise<Backend>;

export class AcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpError";
  }
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const jsonRpcResult = (id: JsonRpcId, result: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  result,
});

export const jsonRpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const jsonRpcNotification = (method: string, params: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  method,
  params,
});

export class LineFramer {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  push(chunk: Uint8Array | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  flush(): string[] {
    this.buffer += this.decoder.decode();
    const lines = this.drain();
    const trailing = this.buffer.trim();
    this.buffer = "";
    if (trailing) lines.push(trailing);
    return lines;
  }

  private drain(): string[] {
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length) lines.push(line);
    }
    return lines;
  }
}

export const initializeResult = (): Record<string, unknown> => ({
  protocolVersion: ACP_PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
    mcpCapabilities: { http: false, sse: false },
    sessionCapabilities: { close: {} },
    auth: {},
  },
  agentInfo: { name: "dori-acp", title: "Dori", version: "0.1.0" },
  authMethods: [],
});

export const promptText = (prompt: unknown): string | undefined => {
  if (!Array.isArray(prompt)) return undefined;
  const parts: string[] = [];
  for (const block of prompt as readonly ContentBlock[]) {
    if (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.length ? parts.join("\n\n") : undefined;
};
