// A failed reviewer-tree kill is fatal for the attempt: the old reviewer may still be alive, so a fallback or the next
// chunk must not start and overwrite the one marker that names it. This records the failure and stops the plan.

import { markNotRun, type ProgressUnit, updateUnit } from "./review-progress.ts";
import type { LaneResult, LaneRun } from "./review-report.ts";

/** Records a kill-failed result, marks the remaining plan stopped, saves progress, and returns why it stopped. */
export async function stopOnKillFailure(
  result: LaneResult,
  run: LaneRun,
  units: ProgressUnit[],
  results: LaneResult[],
  savePartial: () => Promise<void>,
): Promise<string | undefined> {
  const why = result.outcome.kind === "timeout" ? result.outcome.killFailed : undefined;
  if (why === undefined) return undefined;
  results.push(result);
  updateUnit(units, run, {
    state: "timed out",
    ...(result.model === undefined ? {} : { model: result.model }),
    durationMs: result.outcome.durationMs,
    note: `kill failed: ${why}`,
  });
  markNotRun(units, "stopped after a failed reviewer-tree kill");
  await savePartial();
  return why;
}
