import type { StopReason } from "./protocol.ts";

export type SenpiChild = {
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

export type ActiveTurn = {
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

export type SenpiMessage = {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly success?: unknown;
  readonly command?: unknown;
  readonly error?: unknown;
  readonly reason?: unknown;
  readonly aborted?: unknown;
  readonly failure?: unknown;
  readonly assistantMessageEvent?: unknown;
  readonly message?: unknown;
};

export type SenpiDelta = { readonly type?: unknown; readonly delta?: unknown };
export type SenpiTurnMessage = { readonly role?: unknown; readonly content?: unknown };
export type SenpiTextBlock = { readonly type?: unknown; readonly text?: unknown };
export type SenpiFailure = { readonly reason?: unknown; readonly category?: unknown };
