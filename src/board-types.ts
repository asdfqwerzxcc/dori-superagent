import { Refusal } from "./refusal.ts";

/**
 * The local port of Vercel Board's task model: a task is a thread whose root says what to do, whose replies are the
 * work log, and whose state the board keeps. `reopened` is a transition, not a resting state: reopening a failed or
 * canceled task puts it back to `ready` (or `waiting` while a prerequisite has not completed).
 */
export const TASK_STATES = ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const OPEN_STATES: readonly TaskState[] = ["waiting", "ready", "claimed", "blocked"];
export const TERMINAL_STATES: readonly TaskState[] = ["completed", "failed", "canceled"];

export const isOpen = (state: TaskState): boolean => OPEN_STATES.includes(state);
export const isTerminal = (state: TaskState): boolean => TERMINAL_STATES.includes(state);

/** Every state-changing operation. `needs` changes the DAG and then re-derives `waiting`/`ready`. */
export const BOARD_OPS = [
  "claim",
  "renew",
  "release",
  "complete",
  "fail",
  "block",
  "unblock",
  "cancel",
  "reopen",
  "needs",
] as const;

export type BoardOp = (typeof BOARD_OPS)[number];

/** The single transition table: every operation names the states it is allowed from. Everything else is refused. */
export const TRANSITIONS: Record<BoardOp, readonly TaskState[]> = {
  claim: ["ready"],
  renew: ["claimed"],
  release: ["claimed"],
  complete: ["claimed"],
  fail: ["claimed"],
  block: ["claimed"],
  unblock: ["blocked"],
  cancel: ["waiting", "ready", "claimed", "blocked"],
  reopen: ["failed", "canceled"],
  needs: ["waiting", "ready", "blocked"],
};

export const allows = (op: BoardOp, state: TaskState): boolean => TRANSITIONS[op].includes(state);

/** The reasons a board command can fail with; the CLI prints the reason first and `--json` puts it in the document. */
export type BoardReason =
  | "bad_request"
  | "task_not_found"
  | "thread_not_found"
  | "task_claimed"
  | "claim_lost"
  | "nothing_ready"
  | "task_waiting"
  | "task_blocked"
  | "task_finished"
  | "invalid_needs"
  | "board_busy"
  | "board_corrupt";

export class BoardError extends Refusal {
  constructor(
    readonly reason: BoardReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

export type BoardMessage = { id: string; at: number; text: string; labels?: string[] };

export type BoardThread = { id: string; channel: string; createdAt: number; messages: BoardMessage[] };

/** A claim is a lease: `leaseUntil` is when it stops counting, and `epoch` is bumped on every new claim of the task. */
export type BoardClaim = {
  token: string;
  epoch: number;
  at: number;
  leaseSeconds: number;
  leaseUntil: number;
  worker?: string;
};

export type BoardTask = {
  id: string;
  title: string;
  channel: string;
  state: TaskState;
  needs: string[];
  data: Record<string, string>;
  epoch: number;
  createdAt: number;
  updatedAt: number;
  claim?: BoardClaim;
  hold?: { reason: string; kind?: string; at: number };
  result?: string;
  reason?: string;
  worker?: string;
  completedAt?: number;
};

/** The folded board. Threads are keyed by id, and a task's id is also its thread id. */
export type Board = { threads: Record<string, BoardThread>; tasks: Record<string, BoardTask>; order: string[] };

type EventBase = { v: 1; id: string; at: number };

/** One append-only line of `state/board.jsonl`. `board.snapshot` is only written by the explicit `compact`. */
export type BoardEvent =
  | (EventBase & { kind: "board.snapshot"; board: Board })
  | (EventBase & {
      kind: "thread.created";
      thread: { id: string; channel: string; createdAt: number };
      message: BoardMessage;
    })
  | (EventBase & { kind: "message.created"; thread: string; message: BoardMessage })
  | (EventBase & {
      kind: "task.created";
      task: { id: string; title: string; channel: string; needs: string[]; data: Record<string, string> };
      root: BoardMessage;
    })
  | (EventBase & {
      kind: "task.claimed";
      task: string;
      token: string;
      epoch: number;
      leaseSeconds: number;
      leaseUntil: number;
      worker?: string;
    })
  | (EventBase & { kind: "task.renewed"; task: string; token: string; epoch: number; leaseUntil: number })
  | (EventBase & { kind: "task.released"; task: string; token: string; epoch: number; reason?: string })
  | (EventBase & {
      kind: "task.completed";
      task: string;
      token: string;
      epoch: number;
      result: string;
      worker?: string;
    })
  | (EventBase & { kind: "task.failed"; task: string; token: string; epoch: number; reason: string })
  | (EventBase & {
      kind: "task.blocked";
      task: string;
      token: string;
      epoch: number;
      reason: string;
      holdKind?: string;
    })
  | (EventBase & { kind: "task.unblocked"; task: string })
  | (EventBase & { kind: "task.canceled"; task: string; reason: string })
  | (EventBase & { kind: "task.reopened"; task: string })
  | (EventBase & { kind: "task.needs"; task: string; needs: string[] });

export type ClaimView = Omit<BoardClaim, "token">;

export type TaskView = Omit<BoardTask, "claim"> & { claim?: ClaimView };

/** The shape the CLI and `read` expose: a claim is visible, its token is not. The claim command prints the token once. */
export function viewTask(task: BoardTask): TaskView {
  const { claim, ...rest } = task;
  if (claim === undefined) return rest;
  return {
    ...rest,
    claim: {
      epoch: claim.epoch,
      at: claim.at,
      leaseSeconds: claim.leaseSeconds,
      leaseUntil: claim.leaseUntil,
      ...(claim.worker === undefined ? {} : { worker: claim.worker }),
    },
  };
}
