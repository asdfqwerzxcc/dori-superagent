import type { Deps } from "./harness.ts";
import { cleanText, normalizeChannel, unique } from "./board-input.ts";
import { foldBoard, loadBoard, newId, readEvents, withLock } from "./board-log.ts";
import { appendTask, assertNeeds, byCreated, mutateTask, requireTask, requireTransition } from "./board-task-common.ts";
import { type BoardEvent, type BoardTask, BoardError, isOpen, isTerminal, type TaskState } from "./board-types.ts";

export type CreateTaskInput = {
  title: string;
  needs?: readonly string[];
  data?: Record<string, string>;
  channel?: string;
};

export function createTask(d: Deps, input: CreateTaskInput): BoardTask {
  const title = cleanText(input.title, "title");
  const needs = unique([...(input.needs ?? [])], "--needs");
  const channel = normalizeChannel(input.channel);
  const data = { ...(input.data ?? {}) };
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const id = newId("t");
    assertNeeds(board, id, needs);
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.created",
      task: { id, title, channel, needs, data },
      root: { id: newId("m"), at, text: title },
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}

export type TaskFilter = TaskState | "done" | "all";

export function listTasks(d: Deps, filter?: TaskFilter): BoardTask[] {
  const tasks = Object.values(loadBoard(d.store.root, d.now()).tasks).sort(byCreated);
  if (filter === "all") return tasks;
  if (filter === "done") return tasks.filter((task) => isTerminal(task.state));
  if (filter === undefined) return tasks.filter((task) => isOpen(task.state));
  return tasks.filter((task) => task.state === filter);
}

export function unblockTask(d: Deps, id: string): BoardTask {
  return mutateTask(d, (board, at) => {
    requireTransition("unblock", requireTask(board, id));
    const event: BoardEvent = { v: 1, id: newId("e"), at, kind: "task.unblocked", task: id };
    return { event, id };
  });
}

export function cancelTask(d: Deps, id: string, reason = "canceled"): BoardTask {
  const text = cleanText(reason, "reason");
  return mutateTask(d, (board, at) => {
    requireTransition("cancel", requireTask(board, id));
    const event: BoardEvent = { v: 1, id: newId("e"), at, kind: "task.canceled", task: id, reason: text };
    return { event, id };
  });
}

export function reopenTask(d: Deps, id: string): BoardTask {
  return mutateTask(d, (board, at) => {
    requireTransition("reopen", requireTask(board, id));
    const event: BoardEvent = { v: 1, id: newId("e"), at, kind: "task.reopened", task: id };
    return { event, id };
  });
}

export type NeedsChange = { add?: readonly string[]; remove?: readonly string[] };

export function changeNeeds(d: Deps, id: string, change: NeedsChange): BoardTask {
  const add = unique([...(change.add ?? [])], "--add");
  const remove = unique([...(change.remove ?? [])], "--remove");
  if (add.length === 0 && remove.length === 0) throw new BoardError("bad_request", "give --add or --remove");
  if (add.length > 0 && remove.length > 0) throw new BoardError("bad_request", "give --add or --remove, not both");
  return mutateTask(d, (board, at) => {
    const task = requireTask(board, id);
    requireTransition("needs", task);
    const set = new Set(task.needs);
    for (const need of remove)
      if (!set.delete(need)) throw new BoardError("invalid_needs", `${need} is not a need of ${id}`);
    for (const need of add) set.add(need);
    const needs = [...set];
    assertNeeds(board, id, needs);
    const event: BoardEvent = { v: 1, id: newId("e"), at, kind: "task.needs", task: id, needs };
    return { event, id };
  });
}
