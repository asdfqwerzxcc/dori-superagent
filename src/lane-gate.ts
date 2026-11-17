import type { Deps } from "./harness.ts";
import { laneHead, laneRepo } from "./lane-repo.ts";
import { reviewJobFor } from "./review-queue.ts";
import { reviewLogPath } from "./review-run.ts";
import type { Lane } from "./store-types.ts";

export type LaneGate = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly reason: string };

/**
 * What `dori done` asks before closing: the current tip has a CLEAR receipt, or the lane committed nothing (base ===
 * tip), or the lane has no recorded base (started before the gate) and closes with an explicit note. A receipt that
 * says the reviewer timed out or printed nothing is a refusal like BLOCK: a failed review is never a pass.
 */
export async function laneGate(d: Deps, lane: Lane): Promise<LaneGate> {
  if (lane.baseSha === undefined)
    return { ok: true, note: `no review gate: lane ${lane.key} has no recorded base commit` };
  const tip = await laneHead(d, lane);
  if (tip === undefined)
    return {
      ok: false,
      reason: `lane ${lane.key}: cannot read HEAD in ${laneRepo(lane)}; fix the checkout, then run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  if (tip === lane.baseSha) return { ok: true };
  const receipt = d.store.laneReceipt(lane.key, tip);
  if (!receipt) {
    // A queued review is already running somewhere else: done says so instead of sending the lead to review it again.
    const job = reviewJobFor(d.store.root, lane.key, tip);
    if (job !== undefined)
      return {
        ok: false,
        reason:
          `lane ${lane.key} at ${tip.slice(0, 12)}: a review is in flight (${job.state}, requested ${new Date(job.requestedAt).toISOString()}); ` +
          `its verdict will arrive as an inbox message from duty. Run dori done ${lane.key} again once the receipt exists ` +
          `(or dori done --drop ${lane.key} --reason <text>)`,
      };
    return {
      ok: false,
      reason: `lane ${lane.key} at ${tip.slice(0, 12)} has no review receipt; run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  }
  if (receipt.verdict !== "CLEAR") {
    const failed = receipt.verdict === "reviewer_timeout" || receipt.verdict === "reviewer_empty";
    const log = failed ? `; log: ${reviewLogPath(d.store.root, lane.key)}` : "";
    return {
      ok: false,
      reason: `lane ${lane.key} at ${tip.slice(0, 12)} is ${receipt.verdict}${log}; run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  }
  return { ok: true };
}

/** `reviewed`, a non-CLEAR verdict or `no receipt` for one lane row in `dori status`, read at the lane's current tip. */
export async function reviewLabel(d: Deps, lane: Lane): Promise<string> {
  if (lane.baseSha === undefined) return "no receipt";
  const tip = (await laneHead(d, lane)) ?? lane.tipSha;
  if (tip === undefined) return "no receipt";
  const receipt = d.store.laneReceipt(lane.key, tip);
  if (!receipt) return "no receipt";
  return receipt.verdict === "CLEAR" ? "reviewed" : receipt.verdict;
}
