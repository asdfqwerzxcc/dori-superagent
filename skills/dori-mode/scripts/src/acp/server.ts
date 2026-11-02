import { isAbsolute } from "node:path";

import {
  AcpError,
  INVALID_PARAMS,
  INVALID_REQUEST,
  INTERNAL_ERROR,
  JsonRpcError,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  initializeResult,
  isRecord,
  jsonRpcError,
  jsonRpcNotification,
  jsonRpcResult,
  promptText,
  type Backend,
  type BackendFactory,
  type JsonRpcId,
} from "./protocol.ts";

type Session = {
  readonly id: string;
  readonly backend: Backend;
  readonly cwd: string;
  busy: boolean;
  cancelRequested: boolean;
};

export type AcpServerOptions = {
  readonly write: (message: Record<string, unknown>) => void;
  readonly createBackend: BackendFactory;
  readonly log?: (line: string) => void;
};

export class AcpServer {
  private readonly opts: AcpServerOptions;
  private readonly log: (line: string) => void;
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  constructor(opts: AcpServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => undefined);
  }

  async handleLine(line: string): Promise<void> {
    if (this.closed || !line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.opts.write(jsonRpcError(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (!isRecord(parsed)) {
      this.opts.write(jsonRpcError(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    if (typeof parsed.method !== "string") {
      if ("result" in parsed || "error" in parsed) return;
      this.opts.write(jsonRpcError(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    const id = parsed.id;
    if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
      this.opts.write(jsonRpcError(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    const requestId: JsonRpcId = id === undefined ? null : id;
    const notification = id === undefined;
    try {
      const result = await this.dispatch(parsed.method, parsed.params);
      if (!notification) this.opts.write(jsonRpcResult(requestId, result ?? null));
    } catch (error) {
      const rpc = this.toRpcError(error, parsed.method);
      if (notification) {
        this.log(`${parsed.method} notification failed: ${rpc.message}`);
        return;
      }
      this.opts.write(jsonRpcError(requestId, rpc.code, rpc.message, rpc.data));
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map(async (session) => {
      try {
        await session.backend.close();
      } catch (error) {
        this.log(`session ${session.id} close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return initializeResult();
      case "session/new":
        return this.newSession(params);
      case "session/prompt":
        return this.prompt(params);
      case "session/cancel":
        return this.cancel(params);
      case "session/close":
        return this.closeSession(params);
      default:
        throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private async newSession(params: unknown): Promise<{ readonly sessionId: string }> {
    const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
    if (!cwd) throw new JsonRpcError(INVALID_PARAMS, "session/new requires cwd");
    if (!isAbsolute(cwd)) throw new JsonRpcError(INVALID_PARAMS, "session/new cwd must be an absolute path");
    let backend: Backend;
    try {
      backend = await this.opts.createBackend({ cwd });
    } catch (error) {
      throw new JsonRpcError(INTERNAL_ERROR, `could not create the session backend: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sessionId = `sess_${crypto.randomUUID()}`;
    this.sessions.set(sessionId, { id: sessionId, backend, cwd, busy: false, cancelRequested: false });
    return { sessionId };
  }

  private async prompt(params: unknown): Promise<{ readonly stopReason: string }> {
    const session = this.requireSession(params);
    const text = isRecord(params) ? promptText(params.prompt) : undefined;
    if (!text) throw new JsonRpcError(INVALID_PARAMS, "session/prompt requires at least one text content block");
    if (session.busy) throw new JsonRpcError(INTERNAL_ERROR, "the session already has a prompt in progress");
    session.busy = true;
    session.cancelRequested = false;
    try {
      const stop = await session.backend.prompt(text, (chunk) => {
        this.opts.write(jsonRpcNotification("session/update", {
          sessionId: session.id,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
        }));
      });
      return { stopReason: session.cancelRequested ? "cancelled" : stop };
    } catch (error) {
      if (session.cancelRequested) return { stopReason: "cancelled" };
      throw new JsonRpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    } finally {
      session.busy = false;
      session.cancelRequested = false;
    }
  }

  private async cancel(params: unknown): Promise<void> {
    const session = this.requireSession(params);
    if (!session.busy) return;
    session.cancelRequested = true;
    try {
      await session.backend.cancel();
    } catch (error) {
      this.log(`session ${session.id} cancel failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async closeSession(params: unknown): Promise<Record<string, never>> {
    const session = this.requireSession(params);
    this.sessions.delete(session.id);
    session.cancelRequested = true;
    try {
      await session.backend.close();
    } catch (error) {
      this.log(`session ${session.id} close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }

  private requireSession(params: unknown): Session {
    const sessionId = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : "";
    if (!sessionId) throw new JsonRpcError(INVALID_PARAMS, "sessionId is required");
    const session = this.sessions.get(sessionId);
    if (!session) throw new JsonRpcError(INVALID_PARAMS, `unknown session: ${sessionId}`);
    return session;
  }

  private toRpcError(error: unknown, method: string): { code: number; message: string; data?: unknown } {
    if (error instanceof JsonRpcError) return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) };
    if (error instanceof AcpError) return { code: INTERNAL_ERROR, message: error.message };
    const message = error instanceof Error ? error.message : String(error);
    this.log(`${method} failed: ${message}`);
    return { code: INTERNAL_ERROR, message: "internal error" };
  }
}
