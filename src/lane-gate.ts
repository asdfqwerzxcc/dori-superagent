import type { Deps } from "./harness.ts";
import { laneHead, laneRepo } from "./lane-repo.ts";
import { reviewJobFor } from "./review-queue.ts";
import type { Lane } from "./store-types.ts";

export type LaneGate =
  | { readonly ok: true; readonly note?: string }
  | { readonly ok: false; readonly reason: string; readonly headUnreadable?: true };

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
      headUnreadable: true,
      reason: `lane ${lane.key}: cannot read HEAD in ${laneRepo(lane)}; fix the checkout, then run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  if (tip === lane.baseSha) return { ok: true };
  const receipt = d.store.laneReceipt(lane.key, tip);
  const job = reviewJobFor(d.store.root, lane.key, tip);
  // A queued request is the lead's work now: done says so instead of sending the lead to review it again. A legacy
  // `review_partial` receipt must not hide the request that was queued after it.
  if ((!receipt || receipt.verdict === "review_partial") && job !== undefined) {
    if (job === "corrupt")
      return {
        ok: false,
        reason:
          `lane ${lane.key} at ${tip.slice(0, 12)}: a review request is queued but unreadable (the next duty pass drops it); ` +
          `queue it again with dori review --lane ${lane.key}, or attest the reviewer verdict with dori review ${lane.key} --attest ...`,
      };
    // A record can outlive its writer with a time no Date can render; the refusal must still print, never throw.
    const at = new Date(job.requestedAt);
    const when = Number.isNaN(at.getTime()) ? String(job.requestedAt) : at.toISOString();
    return {
      ok: false,
      reason:
        `lane ${lane.key} at ${tip.slice(0, 12)}: a review request is queued (${job.state}, requested ${when}); ` +
        `run the review in its own session with dori review <owner/repo#N>, then record the verdict with ` +
        `dori review ${lane.key} --attest --verdict CLEAR|BLOCK ` +
        `--reviewer <name> --evidence <report>; run dori done ${lane.key} again once the receipt exists ` +
        `(or dori done --drop ${lane.key} --reason <text>)`,
    };
  }
  if (!receipt)
    return {
      ok: false,
      reason:
        `lane ${lane.key} at ${tip.slice(0, 12)} has no review receipt; run: dori review --lane ${lane.key} to queue it, ` +
        `then record the reviewer verdict with dori review ${lane.key} --attest ... (or dori done --drop ${lane.key} --reason <text>)`,
    };
  if (receipt.verdict !== "CLEAR") {
    const pending = receipt.verdict === "review_partial" ? " (a legacy chunked review did not finish every chunk)" : "";
    return {
      ok: false,
      reason:
        `lane ${lane.key} at ${tip.slice(0, 12)} is ${receipt.verdict}${pending}; run: dori review --lane ${lane.key} to queue it again, ` +
        `then attest the reviewer verdict (or dori done --drop ${lane.key} --reason <text>)`,
    };
  }
  return { ok: true };
}

/** `reviewed`, `queued`, a non-CLEAR verdict or `no receipt` for one lane row in `dori status`. */
export async function reviewLabel(d: Deps, lane: Lane): Promise<string> {
  if (lane.baseSha === undefined) return "no receipt";
  const tip = (await laneHead(d, lane)) ?? lane.tipSha;
  if (tip === undefined) return "no receipt";
  const receipt = d.store.laneReceipt(lane.key, tip);
  if (!receipt) {
    const job = reviewJobFor(d.store.root, lane.key, tip);
    if (job === "corrupt") return "unreadable";
    return job !== undefined ? "queued" : "no receipt";
  }
  return receipt.verdict === "CLEAR" ? "reviewed" : receipt.verdict;
}
