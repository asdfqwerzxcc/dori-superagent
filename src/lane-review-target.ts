import type { Deps } from "./harness.ts";
import { asSha, gitOut, laneHead, laneRepo } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import { KEY_RE, type Lane } from "./store-types.ts";

/** The lane, its checkout, its current tip and the merge-base a review of it covers. */
export type LaneReviewTarget = { lane: Lane; repo: string; tip: string; base: string };

/**
 * Resolves what `dori review --lane` hands the lead's reviewer: the lane, its checkout, its current tip and the
 * merge-base a review of it covers. The request and the attestation both read it here, so both pin the same range.
 */
export async function laneReviewTarget(d: Deps, key: string): Promise<LaneReviewTarget> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.baseSha === undefined)
    throw new Refusal(
      `lane ${key} has no recorded base commit (it started before the review gate); dori review --lane covers lanes started by this version`,
    );
  const repo = laneRepo(lane);
  const tip = await laneHead(d, lane);
  if (tip === undefined)
    throw new Refusal(`cannot read HEAD in ${repo}: the lane's checkout is gone or not a git repository`);
  const base = asSha(await gitOut(d, repo, ["merge-base", lane.baseSha, tip]));
  if (base === undefined)
    throw new Refusal(`cannot find the merge-base of ${lane.baseSha.slice(0, 12)} and ${tip.slice(0, 12)} in ${repo}`);
  if (base === tip) throw new Refusal(`lane ${key} has no commits since ${base.slice(0, 12)}; nothing to review`);
  return { lane, repo, tip, base };
}
