import type { Deps } from "./harness.ts";
import {
  type Board,
  type BoardClaim,
  type BoardEvent,
  type BoardOp,
  type BoardTask,
  BoardError,
  allows,
} from "./board-types.ts";
import { appendEvent, foldBoard, readEvents, withLock } from "./board-log.ts";

export function requireTask(board: Board, id: string): BoardTask {
  const task = board.tasks[id];
  if (task === undefined) throw new BoardError("task_not_found", id);
  return task;
}

export function claimRefusal(task: BoardTask): BoardError {
  switch (task.state) {
    case "claimed":
      return new BoardError(
        "task_claimed",
        `${task.id} is already claimed${task.claim?.worker === undefined ? "" : ` by ${task.claim.worker}`}`,
      );
    case "waiting":
      return new BoardError("task_waiting", `${task.id} waits on ${task.needs.join(", ")}`);
    case "blocked":
      return new BoardError("task_blocked", `${task.id} is held: ${task.hold?.reason ?? "blocked"}`);
    default:
      return new BoardError("task_finished", `${task.id} is ${task.state}`);
  }
}

export const claimLost = (task: BoardTask): BoardError =>
  new BoardError("claim_lost", `the claim on ${task.id} is over (state ${task.state})`);

function transitionError(op: BoardOp, task: BoardTask): BoardError {
  switch (op) {
    case "claim":
      return claimRefusal(task);
    case "renew":
    case "release":
    case "complete":
    case "fail":
    case "block":
      return claimLost(task);
    case "unblock":
      return new BoardError("bad_request", `${task.id} is ${task.state}, not blocked`);
    case "cancel":
      return new BoardError("task_finished", `${task.id} is ${task.state}`);
    case "reopen":
      return new BoardError("bad_request", `${task.id} is ${task.state}; only failed or canceled tasks reopen`);
    case "needs":
      return task.state === "claimed"
        ? new BoardError("task_claimed", `${task.id} is claimed; release it before changing needs`)
        : new BoardError("task_finished", `${task.id} is ${task.state}; needs cannot change now`);
  }
}

export function requireTransition(op: BoardOp, task: BoardTask): void {
  if (!allows(op, task.state)) throw transitionError(op, task);
}

export function heldTask(board: Board, id: string, token: string, op: BoardOp): { task: BoardTask; claim: BoardClaim } {
  const task = requireTask(board, id);
  requireTransition(op, task);
  const claim = task.claim;
  if (claim === undefined || claim.token !== token || claim.epoch !== task.epoch) throw claimLost(task);
  return { task, claim };
}

export function appendTask(
  root: string,
  events: readonly BoardEvent[],
  event: BoardEvent,
  at: number,
  id: string,
): BoardTask {
  appendEvent(root, event);
  const task = foldBoard([...events, event], at).tasks[id];
  if (task === undefined) throw new BoardError("board_corrupt", `event did not leave a task ${id}`);
  return task;
}

export function mutateTask(d: Deps, run: (board: Board, at: number) => { event: BoardEvent; id: string }): BoardTask {
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { event, id } = run(board, at);
    return appendTask(d.store.root, events, event, at, id);
  });
}

export function assertNeeds(board: Board, id: string, needs: readonly string[]): void {
  for (const need of needs) {
    if (need === id) throw new BoardError("invalid_needs", `${id} cannot wait on itself`);
    if (board.tasks[need] === undefined) throw new BoardError("invalid_needs", `no task ${need}`);
  }
  const seen = new Set<string>();
  const stack = [...needs];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === id) throw new BoardError("invalid_needs", `a dependency chain from ${id} reaches ${id}`);
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(board.tasks[current]?.needs ?? []));
  }
}

export const byCreated = (a: BoardTask, b: BoardTask): number => a.createdAt - b.createdAt || a.id.localeCompare(b.id);
