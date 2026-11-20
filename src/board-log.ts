import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { takeInboxLock } from "./inbox-lock.ts";
import { type Board, type BoardClaim, type BoardEvent, type BoardTask, BoardError, isTerminal } from "./board-types.ts";

export const boardPath = (root: string): string => join(root, "state", "board.jsonl");
export const boardLockPath = (root: string): string => join(root, "state", "board.lock");

export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString("hex")}`;

export function appendEvent(root: string, event: BoardEvent): void {
  const path = boardPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

export function readEvents(root: string): BoardEvent[] {
  const path = boardPath(root);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  // A reader can catch the tail of a concurrent append; a last line without its newline is not an event yet.
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events: BoardEvent[] = [];
  for (const [index, line] of complete.split("\n").entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new BoardError("board_corrupt", `${path}:${index + 1} is not JSON`);
    }
    const event = raw as { v?: unknown; id?: unknown; kind?: unknown };
    if (event.v !== 1 || typeof event.id !== "string" || typeof event.kind !== "string")
      throw new BoardError("board_corrupt", `${path}:${index + 1} is not a board event`);
    events.push(raw as BoardEvent);
  }
  return events;
}

export function foldBoard(events: readonly BoardEvent[], now: number): Board {
  const board: Board = { threads: {}, tasks: {}, order: [] };
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    applyEvent(board, event);
  }
  settle(board, now);
  return board;
}

export const loadBoard = (root: string, now: number): Board => foldBoard(readEvents(root), now);

function applyEvent(board: Board, event: BoardEvent): void {
  switch (event.kind) {
    case "board.snapshot":
      board.threads = structuredClone(event.board.threads);
      board.tasks = structuredClone(event.board.tasks);
      board.order = [...event.board.order];
      return;
    case "thread.created":
      board.threads[event.thread.id] = {
        id: event.thread.id,
        channel: event.thread.channel,
        createdAt: event.thread.createdAt,
        messages: [event.message],
      };
      board.order.push(event.thread.id);
      return;
    case "message.created":
      mustThread(board, event.thread).messages.push(event.message);
      return;
    case "task.created":
      board.tasks[event.task.id] = {
        id: event.task.id,
        title: event.task.title,
        channel: event.task.channel,
        state: "waiting",
        needs: [...event.task.needs],
        data: { ...event.task.data },
        epoch: 0,
        createdAt: event.at,
        updatedAt: event.at,
      };
      board.threads[event.task.id] = {
        id: event.task.id,
        channel: event.task.channel,
        createdAt: event.at,
        messages: [event.root],
      };
      board.order.push(event.task.id);
      return;
    case "task.claimed": {
      const task = mustTask(board, event.task);
      if (event.epoch <= task.epoch)
        throw new BoardError(
          "board_corrupt",
          `claim epoch ${event.epoch} on ${task.id} does not advance ${task.epoch}`,
        );
      task.state = "claimed";
      task.epoch = event.epoch;
      task.updatedAt = event.at;
      task.claim = {
        token: event.token,
        epoch: event.epoch,
        at: event.at,
        leaseSeconds: event.leaseSeconds,
        leaseUntil: event.leaseUntil,
        ...(event.worker === undefined ? {} : { worker: event.worker }),
      };
      if (event.worker !== undefined) task.worker = event.worker;
      return;
    }
    case "task.renewed": {
      const task = mustTask(board, event.task);
      mustClaim(task, event.token, event.epoch).leaseUntil = event.leaseUntil;
      task.updatedAt = event.at;
      return;
    }
    case "task.released": {
      const task = mustTask(board, event.task);
      mustClaim(task, event.token, event.epoch);
      delete task.claim;
      task.state = "ready";
      task.updatedAt = event.at;
      return;
    }
    case "task.completed": {
      const task = mustTask(board, event.task);
      mustClaim(task, event.token, event.epoch);
      delete task.claim;
      task.state = "completed";
      task.result = event.result;
      task.completedAt = event.at;
      task.updatedAt = event.at;
      if (event.worker !== undefined) task.worker = event.worker;
      return;
    }
    case "task.failed": {
      const task = mustTask(board, event.task);
      mustClaim(task, event.token, event.epoch);
      delete task.claim;
      task.state = "failed";
      task.reason = event.reason;
      task.updatedAt = event.at;
      return;
    }
    case "task.blocked": {
      const task = mustTask(board, event.task);
      mustClaim(task, event.token, event.epoch);
      delete task.claim;
      task.state = "blocked";
      task.hold = {
        reason: event.reason,
        at: event.at,
        ...(event.holdKind === undefined ? {} : { kind: event.holdKind }),
      };
      task.updatedAt = event.at;
      return;
    }
    case "task.unblocked": {
      const task = mustTask(board, event.task);
      delete task.hold;
      task.state = "ready";
      task.updatedAt = event.at;
      return;
    }
    case "task.canceled": {
      const task = mustTask(board, event.task);
      delete task.claim;
      delete task.hold;
      task.state = "canceled";
      task.reason = event.reason;
      task.updatedAt = event.at;
      return;
    }
    case "task.reopened": {
      const task = mustTask(board, event.task);
      delete task.claim;
      delete task.hold;
      delete task.result;
      delete task.reason;
      delete task.completedAt;
      task.state = "ready";
      task.updatedAt = event.at;
      return;
    }
    case "task.needs": {
      const task = mustTask(board, event.task);
      task.needs = [...event.needs];
      task.updatedAt = event.at;
      return;
    }
    default:
      throw new BoardError("board_corrupt", `unknown event kind ${String((event as { kind?: unknown }).kind)}`);
  }
}

function settle(board: Board, now: number): void {
  for (const task of Object.values(board.tasks)) {
    if (isTerminal(task.state) || task.state === "blocked") continue;
    if (task.claim !== undefined && now < task.claim.leaseUntil) {
      task.state = "claimed";
      continue;
    }
    delete task.claim;
    task.state = task.needs.every((id) => board.tasks[id]?.state === "completed") ? "ready" : "waiting";
  }
}

function mustTask(board: Board, id: string): BoardTask {
  const task = board.tasks[id];
  if (task === undefined) throw new BoardError("board_corrupt", `event names unknown task ${id}`);
  return task;
}

function mustThread(board: Board, id: string) {
  const thread = board.threads[id];
  if (thread === undefined) throw new BoardError("board_corrupt", `event names unknown thread ${id}`);
  return thread;
}

function mustClaim(task: BoardTask, token: string, epoch: number): BoardClaim {
  const claim = task.claim;
  if (task.state !== "claimed" || claim === undefined || claim.token !== token || claim.epoch !== epoch)
    throw new BoardError("board_corrupt", `event does not match the claim on ${task.id}`);
  return claim;
}

export function withLock<T>(root: string, now: number, run: () => T): T {
  mkdirSync(join(root, "state"), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const release = takeInboxLock(boardLockPath(root), now);
    if (release !== undefined) {
      try {
        return run();
      } finally {
        release();
      }
    }
    Bun.sleepSync(2);
  }
  throw new BoardError("board_busy", "another board command holds state/board.lock; retry in a moment");
}
