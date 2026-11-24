import { AcpError, isRecord, LineFramer, type Backend, type StopReason } from "./protocol.ts";
import { startSenpiChild, shutdownSenpiChild } from "./senpi-child.ts";
import { asError, assertLocalModel, snippet } from "./senpi-process.ts";
import type { ActiveTurn, SenpiBackendOptions, SenpiChild, SenpiMessage } from "./senpi-types.ts";
import { agentEndState, assistantText, responseOf, textDelta } from "./senpi-wire.ts";

export { assertLocalModel, isPidAlive, resolveSenpiCommand } from "./senpi-process.ts";

export class SenpiBackend implements Backend {
  private readonly opts: SenpiBackendOptions;
  private readonly log: (line: string) => void;
  private readonly framer = new LineFramer();
  private child: SenpiChild | undefined;
  private active: ActiveTurn | undefined;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private seq = 0;
  private closed = false;

  constructor(opts: SenpiBackendOptions) {
    assertLocalModel(opts.model);
    if (!opts.cwd.trim()) throw new AcpError("session cwd is empty");
    this.opts = opts;
    this.log = opts.log ?? ((line) => process.stderr.write(`[dori-acp] ${line}\n`));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async prompt(text: string, onText: (text: string) => void): Promise<StopReason> {
    if (this.closed) throw new AcpError("senpi backend is closed");
    if (!text.trim()) throw new AcpError("prompt is empty");
    if (this.active) throw new AcpError("a prompt is already running");
    this.start();
    const id = `acp-prompt-${++this.seq}`;
    const turn = new Promise<StopReason>((resolve, reject) => {
      this.active = {
        onText,
        resolve,
        reject,
        cancelled: false,
        aborted: false,
        textSeen: false,
        done: false,
        failure: undefined,
        abortTimer: undefined,
      };
    });
    this.pending.set(id, {
      resolve: () => undefined,
      reject: (error) => this.failActive(error),
    });
    try {
      this.write({ id, type: "prompt", message: text });
    } catch (error) {
      this.pending.delete(id);
      this.failActive(asError(error));
    }
    return turn;
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active || active.done) return;
    active.cancelled = true;
    try {
      this.write({ type: "abort", awaitIdle: true, graceMs: 5_000 });
    } catch (error) {
      this.log(`abort could not be sent: ${asError(error).message}`);
      this.finish("cancelled");
      return;
    }
    if (active.abortTimer) clearTimeout(active.abortTimer);
    active.abortTimer = setTimeout(() => {
      if (this.active !== active || active.done) return;
      this.log("cancel timed out; killing the senpi child");
      this.finish("cancelled");
      void this.close();
    }, 10_000);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) {
      this.failActive(new AcpError("senpi backend closed"));
      return;
    }
    const active = this.active;
    if (active) {
      active.cancelled = true;
      try {
        this.write({ type: "abort" });
      } catch {}
    }
    await shutdownSenpiChild(child);
    this.finish("cancelled");
    this.failActive(new AcpError("senpi backend closed"));
    if (this.child === child) this.child = undefined;
  }

  private start(): void {
    if (this.child) return;
    if (this.closed) throw new AcpError("senpi backend is closed");
    this.child = startSenpiChild(this.opts, this.framer, {
      onLine: (line) => this.handleLine(line),
      onExit: (child, code, error) => this.onExit(child, code, error),
      closed: () => this.closed,
      log: this.log,
    });
  }

  private handleLine(line: string): void {
    let message: SenpiMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      this.log(`non-JSON on senpi stdout: ${snippet(line)}`);
      return;
    }
    const type = typeof message.type === "string" ? message.type : "";
    switch (type) {
      case "response":
        this.onResponse(message);
        break;
      case "message_update":
        this.onMessageUpdate(message);
        break;
      case "message_end":
        this.onMessageEnd(message);
        break;
      case "agent_end":
        this.onAgentEnd(message);
        break;
      case "agent_settled":
        if (message.reason === "session_closed")
          this.failActive(new AcpError("senpi session closed before the turn settled"));
        else this.finish("end_turn");
        break;
      case "session_closed":
        this.failActive(
          new AcpError(`senpi session closed (${typeof message.reason === "string" ? message.reason : "unknown"})`),
        );
        break;
      default:
        break;
    }
  }

  private onResponse(message: SenpiMessage): void {
    const response = responseOf(message);
    if (!response) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) {
      if (response.command === "prompt") this.log("SENPI_PROMPT_ACK");
      pending.resolve();
      return;
    }
    const command = typeof response.command === "string" ? response.command : "command";
    pending.reject(new AcpError(`senpi ${command} failed: ${snippet(response.detail)}`));
  }

  private onMessageUpdate(message: SenpiMessage): void {
    const text = textDelta(message);
    if (text) this.emitText(text);
  }

  private onMessageEnd(message: SenpiMessage): void {
    const active = this.active;
    if (!active || active.done || active.textSeen) return;
    const text = assistantText(message);
    if (text) this.emitText(text);
  }

  private emitText(text: string): void {
    const active = this.active;
    if (!active || active.done) return;
    active.textSeen = true;
    try {
      active.onText(text);
    } catch (error) {
      this.log(`session update could not be written: ${asError(error).message}`);
    }
  }

  private onAgentEnd(message: SenpiMessage): void {
    const active = this.active;
    if (!active || active.done) return;
    const end = agentEndState(message);
    if (end.aborted) active.aborted = true;
    if (end.failure) active.failure = new AcpError(`senpi turn failed: ${snippet(end.failure)}`);
  }

  private finish(stop: StopReason): void {
    const active = this.active;
    if (!active || active.done) return;
    active.done = true;
    if (active.abortTimer) clearTimeout(active.abortTimer);
    active.abortTimer = undefined;
    this.active = undefined;
    if (active.cancelled || active.aborted) {
      active.resolve("cancelled");
      return;
    }
    if (active.failure) {
      active.reject(active.failure);
      return;
    }
    active.resolve(stop);
  }

  private failActive(error: Error): void {
    const active = this.active;
    if (!active || active.done) return;
    active.done = true;
    if (active.abortTimer) clearTimeout(active.abortTimer);
    active.abortTimer = undefined;
    this.active = undefined;
    active.reject(error);
  }

  private onExit(child: SenpiChild, code: number, error?: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    const detail = error ? error.message : `exit ${code}`;
    if (!this.closed) this.log(`senpi child ended (${detail})`);
    this.failActive(new AcpError(`senpi child ended (${detail})`));
    for (const pending of this.pending.values()) pending.reject(new AcpError(`senpi child ended (${detail})`));
    this.pending.clear();
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child) throw new AcpError("senpi child is not running");
    child.stdin.write(`${JSON.stringify(message)}\n`);
    void child.stdin.flush();
  }
}
