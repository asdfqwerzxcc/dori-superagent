// A reviewer attempt that cannot throw: an exec rejection (a missing agent binary, for example) becomes that chunk's
// failed result with the error text, so the job records it and goes on to the next chunk.

import type { LaneResult, LaneRun } from "./review-report.ts";

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const attemptSafely = async (
  attempt: () => Promise<LaneResult>,
  run: LaneRun,
  model: string | undefined,
): Promise<LaneResult> => {
  const started = Date.now();
  try {
    return await attempt();
  } catch (e) {
    return {
      run,
      argv: [],
      outcome: { kind: "error", message: messageOf(e), durationMs: Date.now() - started },
      ...(model === undefined ? {} : { model }),
    };
  }
};
