// The `dori review --lane` command: hand the job to the duty worker and report it, or run the review inline when no
// worker exists. Kept out of cli.ts so the command's wording (a fresh job, an in-flight duplicate, a restart) lives
// beside the queue semantics it prints.

import type { Deps } from "./harness.ts";
import { reviewLane } from "./lane-review.ts";
import { queueLaneReview, reviewJobId } from "./review-queue.ts";

export async function runReviewLane(
  d: Deps,
  lane: string,
  model: string | undefined,
  restart: boolean,
): Promise<number> {
  const outcome = await queueLaneReview(d, lane, model, { restart });
  if (outcome.kind === "inline") {
    const r = await reviewLane(d, lane, model);
    console.log(`REVIEW_LANE ${lane} tip=${r.tip} verdict=${r.verdict}`);
    return r.verdict === "CLEAR" ? 0 : 1;
  }
  const { job } = outcome;
  const id = reviewJobId(job.lane, job.tip);
  if (outcome.kind === "existing") console.log(`already queued ${id} (${outcome.state})`);
  else console.log(`QUEUED ${job.lane} ${job.tip} ${id}${outcome.kind === "restarted" ? " (restarted)" : ""}`);
  return 0;
}
