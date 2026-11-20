import { renameSync, writeFileSync } from "node:fs";
import { boardPath, foldBoard, newId, readEvents, withLock } from "./board-log.ts";
import type { BoardEvent } from "./board-types.ts";

/** Manual compaction: replace the append-only log with one snapshot that folds to the same board. */
export function compactLog(root: string, now: number): { before: number; threads: number; tasks: number } {
  return withLock(root, now, () => {
    const events = readEvents(root);
    const board = foldBoard(events, now);
    if (events.length === 0) return { before: 0, threads: 0, tasks: 0 };
    const snapshot: BoardEvent = { v: 1, id: newId("e"), at: now, kind: "board.snapshot", board };
    const path = boardPath(root);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
    renameSync(tmp, path);
    return {
      before: events.length,
      threads: Object.keys(board.threads).length,
      tasks: Object.keys(board.tasks).length,
    };
  });
}
