import type { Deps } from "./harness.ts";
import { cleanText, normalizeChannel, validateLabels } from "./board-input.ts";
import { appendEvent, foldBoard, newId, readEvents, withLock } from "./board-log.ts";
import { type BoardEvent, type BoardMessage, type BoardTask, type BoardThread, BoardError } from "./board-types.ts";

export type PostInput = { thread: string; channel?: string; text: string; labels?: readonly string[] };

export type Posted = { thread: string; message: BoardMessage };

export type ThreadView = { thread: BoardThread; task?: BoardTask };

export function postMessage(d: Deps, input: PostInput): Posted {
  const text = cleanText(input.text, "text");
  const labels = validateLabels(input.labels ?? []);
  const channel = input.channel === undefined ? undefined : normalizeChannel(input.channel);
  const at = d.now();
  return withLock(d.store.root, at, () => {
    const events = readEvents(d.store.root);
    const board = foldBoard(events, at);
    const message: BoardMessage = {
      id: newId("m"),
      at,
      text,
      ...(labels.length === 0 ? {} : { labels }),
    };
    if (input.thread === "new") {
      const id = newId("t");
      const event: BoardEvent = {
        v: 1,
        id: newId("e"),
        at,
        kind: "thread.created",
        thread: { id, channel: channel ?? "general", createdAt: at },
        message,
      };
      appendEvent(d.store.root, event);
      return { thread: id, message };
    }
    const thread = board.threads[input.thread];
    if (thread === undefined) throw new BoardError("thread_not_found", input.thread);
    if (channel !== undefined && channel !== thread.channel)
      throw new BoardError(
        "bad_request",
        `--channel applies only to a new thread (${input.thread} is in ${thread.channel})`,
      );
    const event: BoardEvent = { v: 1, id: newId("e"), at, kind: "message.created", thread: input.thread, message };
    appendEvent(d.store.root, event);
    return { thread: input.thread, message };
  });
}

export function replyThread(d: Deps, thread: string, text: string): Posted {
  if (thread === "new") throw new BoardError("bad_request", "reply needs an existing thread id");
  return postMessage(d, { thread, text });
}

export function readThread(d: Deps, id: string): ThreadView {
  const board = foldBoard(readEvents(d.store.root), d.now());
  const thread = board.threads[id];
  if (thread === undefined) throw new BoardError("thread_not_found", id);
  const task = board.tasks[id];
  return task === undefined ? { thread } : { thread, task };
}
