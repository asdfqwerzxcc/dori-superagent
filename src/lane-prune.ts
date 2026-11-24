import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { worktreeRoot } from "./lane-worktree.ts";

export type PruneResult = {
  readonly removed: readonly string[];
  readonly kept: number;
  readonly skipped: readonly string[];
};

/** Finished lane records older than `days` are deleted; a lane with a worktree on disk or a review in flight is kept. */
export function pruneLaneRecords(d: Deps, days: number, now: number = d.now(), dryRun = false): PruneResult {
  const cutoff = now - Math.max(0, days) * 86_400_000;
  const removed: string[] = [];
  const skipped: string[] = [];
  let kept = 0;
  for (const lane of d.store.lanes()) {
    const finished = lane.status === "done" || lane.status === "dropped" || lane.status === "lost";
    if (!finished || (lane.lastActivityAt ?? lane.createdAt) > cutoff) {
      kept++;
      continue;
    }
    if (existsSync(join(worktreeRoot(d), lane.key))) {
      skipped.push(lane.key);
      continue;
    }
    if (!dryRun) d.store.removeLane(lane.key);
    removed.push(lane.key);
  }
  return { removed, kept, skipped };
}
