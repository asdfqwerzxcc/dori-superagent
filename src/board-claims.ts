import type { Deps } from "./harness.ts";
import { cleanKind, cleanText } from "./board-input.ts";
import { foldBoard, newId, readEvents, withLock } from "./board-log.ts";
import { appendTask, byCreated, heldTask, requireTask, requireTransition } from "./board-task-common.ts";
import { type BoardEvent, type BoardTask, BoardError } from "./board-types.ts";

export type ClaimInput = { id?: string; ready?: boolean; lease?: number; worker?: string };

export type Claimed = { task: BoardTask; token: string; epoch: number; leaseUntil: number };

export function claimTask(d: Deps, input: ClaimInput): Claimed {
  const lease = input.lease ?? 300;
  if (!Number.isInteger(lease) || lease < 1 || lease > 300)
    throw new BoardError("bad_request", "--lease must be a whole number of seconds from 1 to 300");
  const pickReady = input.ready === true;
  if ((input.id !== undefined) === pickReady) throw new BoardError("bad_request", "claim takes a task id or --ready");
  const worker = input.worker === undefined ? undefined : cleanText(input.worker, "--for", 100);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    let task: BoardTask | undefined;
    if (input.id !== undefined) task = requireTask(board, input.id);
    else {
      task = Object.values(board.tasks)
        .filter((candidate) => candidate.state === "ready")
        .sort(byCreated)[0];
      if (task === undefined) throw new BoardError("nothing_ready", "no ready task");
    }
    requireTransition("claim", task);
    const epoch = task.epoch + 1;
    const token = newId("c");
    const leaseUntil = at + lease * 1000;
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.claimed",
      task: task.id,
      token,
      epoch,
      leaseSeconds: lease,
      leaseUntil,
      ...(worker === undefined ? {} : { worker }),
    };
    return { task: appendTask(d.store.root, events, event, at, task.id), token, epoch, leaseUntil };
  });
}

export function renewTask(d: Deps, id: string, token: string): BoardTask {
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { claim } = heldTask(board, id, token, "renew");
    const leaseUntil = at + claim.leaseSeconds * 1000;
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.renewed",
      task: id,
      token,
      epoch: claim.epoch,
      leaseUntil,
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}

export function releaseTask(d: Deps, id: string, token: string, reason?: string): BoardTask {
  const note = reason === undefined ? undefined : cleanText(reason, "reason", 1000);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { claim } = heldTask(board, id, token, "release");
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.released",
      task: id,
      token,
      epoch: claim.epoch,
      ...(note === undefined ? {} : { reason: note }),
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}

export function completeTask(d: Deps, id: string, token: string, result: string, worker?: string): BoardTask {
  const text = cleanText(result, "result");
  const who = worker === undefined ? undefined : cleanText(worker, "--for", 100);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { claim } = heldTask(board, id, token, "complete");
    const actor = who ?? claim.worker;
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.completed",
      task: id,
      token,
      epoch: claim.epoch,
      result: text,
      ...(actor === undefined ? {} : { worker: actor }),
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}

export function failTask(d: Deps, id: string, token: string, reason: string): BoardTask {
  const note = cleanText(reason, "reason", 1000);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { claim } = heldTask(board, id, token, "fail");
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.failed",
      task: id,
      token,
      epoch: claim.epoch,
      reason: note,
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}

export function blockTask(d: Deps, id: string, token: string, reason: string, kind?: string): BoardTask {
  const note = cleanText(reason, "reason", 1000);
  const holdKind = cleanKind(kind);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const { claim } = heldTask(board, id, token, "block");
    const event: BoardEvent = {
      v: 1,
      id: newId("e"),
      at,
      kind: "task.blocked",
      task: id,
      token,
      epoch: claim.epoch,
      reason: note,
      ...(holdKind === undefined ? {} : { holdKind }),
    };
    return appendTask(d.store.root, events, event, at, id);
  });
}
