// The ceilings every long run stops at. A worker that reaches one stops at a safe point and reports; duty never kills a
// run for its age. The defaults are conservative: a run that needs more is split or re-briefed by the lead, not extended
// in place. These constants are the single source for the numbers rendered into prompts/review.md, prompts/review-lane.md,
// prompts/lane-footer.md, prompts/duty.md and prompts/lead.md; the slow-review notice derives from the review ceiling.
// docs/workflow.md, docs/review.md and docs/ops-protocol.md repeat the values for readers and must be updated with this
// file.

export type WorkerCeiling = { readonly wallMinutes: number; readonly tokens: number };

/** One reviewer session: one diff, no writes. Two hours matches the slow notice duty already sends once. */
export const REVIEW_CEILING: WorkerCeiling = { wallMinutes: 2 * 60, tokens: 250_000 };

/** One lane: implementation, tests and its own evidence. Longer than a review, still bounded. */
export const LANE_CEILING: WorkerCeiling = { wallMinutes: 3 * 60, tokens: 400_000 };

/** `2 hours`, the wall-clock half of a ceiling, for notices that fire on time alone. */
export function wallText(c: WorkerCeiling): string {
  return c.wallMinutes % 60 === 0 ? `${c.wallMinutes / 60} hours` : `${c.wallMinutes} minutes`;
}

/** `2 hours or 250000 tokens`, the form the prompts use. */
export function ceilingText(c: WorkerCeiling): string {
  return `${wallText(c)} or ${c.tokens} tokens`;
}

/** Template variables for every prompt that states a ceiling. */
export const CEILING_VARS: Readonly<Record<string, string>> = {
  reviewCeiling: ceilingText(REVIEW_CEILING),
  laneCeiling: ceilingText(LANE_CEILING),
  reviewWall: wallText(REVIEW_CEILING),
};
