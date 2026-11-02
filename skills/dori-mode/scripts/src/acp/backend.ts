import { AcpError, isRecord, LineFramer, type Backend, type StopReason } from "./protocol.ts";

const FORBIDDEN_PROVIDERS = new Set(["goat", "dori"]);

export const assertLocalModel = (model: string): void => {
  const trimmed = model.trim();
  if (!trimmed) throw new AcpError("defaultModel is empty; set one in ~/.dori/config.json");
  const provider = (trimmed.split("/")[0] ?? "").trim().toLowerCase();
  if (FORBIDDEN_PROVIDERS.has(provider)) {
    throw new AcpError(`refusing GOAT provider "${provider}" as the ACP backend; ACP only delegates to a local senpi process`);
  }
};

export const resolveSenpiCommand = (env: Record<string, string | undefined> = process.env): string[] => {
  const raw = env.DORI_ACP_SENPI?.trim();
  if (!raw) return ["senpi"];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")) {
      return parsed as string[];
    }
  } catch {
    return [raw];
  }
  return [raw];
};

export const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const killProcessTree = async (pid: number): Promise<void> => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      await killer.exited;
    } catch {
      return;
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  await Bun.sleep(200);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
};

type SenpiChild = {
  readonly pid: number;
  readonly stdin: { write(chunk: string): number; flush(): number | Promise<number>; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
};

export type SenpiBackendOptions = {
  readonly model: string;
  readonly cwd: string;
  readonly command?: readonly string[];
  readonly permissionPreset?: string | false;
  readonly log?: (line: string) => void;
};

type ActiveTurn = {
  readonly onText: (text: string) => void;
  readonly resolve: (stop: StopReason) => void;
  readonly reject: (error: Error) => void;
  cancelled: boolean;
  aborted: boolean;
  textSeen: boolean;
  done: boolean;
  failure: Error | undefined;
  abortTimer: ReturnType<typeof setTimeout> | undefined;
};

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

const snippet = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 400);

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
      this.active = { onText, resolve, reject, cancelled: false, aborted: false, textSeen: false, done: false, failure: undefined, abortTimer: undefined };
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
    try {
      child.stdin.end();
    } catch {}
    await Promise.race([child.exited.catch(() => 0), Bun.sleep(1_500)]);
    await killProcessTree(child.pid);
    await Promise.race([child.exited.catch(() => 0), Bun.sleep(3_000)]);
    this.finish("cancelled");
    this.failActive(new AcpError("senpi backend closed"));
    if (this.child === child) this.child = undefined;
  }

  private start(): void {
    if (this.child) return;
    if (this.closed) throw new AcpError("senpi backend is closed");
    const command = this.opts.command ?? resolveSenpiCommand();
    const args = ["--mode", "rpc", "--model", this.opts.model];
    if (this.opts.permissionPreset !== false) args.push("--permission-preset", this.opts.permissionPreset ?? "full-access");
    const argv = [...command, ...args];
    let spawned: SenpiChild;
    try {
      spawned = Bun.spawn(argv, {
        cwd: this.opts.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
        ...(process.platform === "win32" ? {} : { detached: true }),
      }) as unknown as SenpiChild;
    } catch (error) {
      throw new AcpError(`could not start senpi: ${asError(error).message}`);
    }
    this.child = spawned;
    this.log(`SENPI_CHILD pid=${spawned.pid}`);
    void this.readStdout(spawned);
    void this.readStderr(spawned);
    spawned.exited.then(
      (code) => this.onExit(spawned, code),
      (error) => this.onExit(spawned, -1, asError(error)),
    );
  }

  private async readStdout(child: SenpiChild): Promise<void> {
    const reader = child.stdout.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of this.framer.push(value)) this.handleLine(line);
      }
      for (const line of this.framer.flush()) this.handleLine(line);
    } catch (error) {
      if (!this.closed) this.log(`senpi stdout read failed: ${asError(error).message}`);
    }
  }

  private async readStderr(child: SenpiChild): Promise<void> {
    const reader = child.stderr.getReader();
    const framer = new LineFramer();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        for (const line of framer.push(value)) this.log(`senpi: ${snippet(line)}`);
      }
      for (const line of framer.flush()) this.log(`senpi: ${snippet(line)}`);
    } catch (error) {
      if (!this.closed) this.log(`senpi stderr read failed: ${asError(error).message}`);
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
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
        if (message.reason === "session_closed") this.failActive(new AcpError("senpi session closed before the turn settled"));
        else this.finish("end_turn");
        break;
      case "session_closed":
        this.failActive(new AcpError(`senpi session closed (${typeof message.reason === "string" ? message.reason : "unknown"})`));
        break;
      default:
        break;
    }
  }

  private onResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const pending = this.pending.get(String(id));
    if (!pending) return;
    this.pending.delete(String(id));
    if (message.success === true) {
      if (message.command === "prompt") this.log("SENPI_PROMPT_ACK");
      pending.resolve();
      return;
    }
    const detail = typeof message.error === "string" && message.error.trim() ? message.error : "unknown error";
    pending.reject(new AcpError(`senpi ${typeof message.command === "string" ? message.command : "command"} failed: ${snippet(detail)}`));
  }

  private onMessageUpdate(message: Record<string, unknown>): void {
    const event = message.assistantMessageEvent;
    if (!isRecord(event) || event.type !== "text_delta" || typeof event.delta !== "string" || !event.delta) return;
    const active = this.active;
    if (!active || active.done) return;
    active.textSeen = true;
    try {
      active.onText(event.delta);
    } catch (error) {
      this.log(`session update could not be written: ${asError(error).message}`);
    }
  }

  private onMessageEnd(message: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.done || active.textSeen) return;
    const whole = message.message;
    if (!isRecord(whole) || whole.role !== "assistant") return;
    let text = "";
    if (typeof whole.content === "string") text = whole.content;
    else if (Array.isArray(whole.content)) {
      for (const block of whole.content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") text += block.text;
      }
    }
    if (!text) return;
    active.textSeen = true;
    try {
      active.onText(text);
    } catch (error) {
      this.log(`session update could not be written: ${asError(error).message}`);
    }
  }

  private onAgentEnd(message: Record<string, unknown>): void {
    const active = this.active;
    if (!active || active.done) return;
    if (message.aborted === true) active.aborted = true;
    const failure = message.failure;
    if (isRecord(failure)) {
      const reason = typeof failure.reason === "string" ? failure.reason : typeof failure.category === "string" ? failure.category : "unknown";
      active.failure = new AcpError(`senpi turn failed: ${snippet(reason)}`);
    }
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
