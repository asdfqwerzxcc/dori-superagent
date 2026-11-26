import type { Deps } from "./harness.ts";
import { laneReceiptFor } from "./lane-patch.ts";
import { gitOut, laneHead, laneRepo } from "./lane-repo.ts";
import { reviewJobFor } from "./review-queue.ts";
import type { Lane, LaneReceipt } from "./store-types.ts";

export type LaneGate =
  | {
      readonly ok: true;
      readonly note?: string;
      /** HEAD the gate read when it decided. */
      readonly tip?: string;
      /** The receipt the gate accepted: the tip's own, or one a commit the lane already landed carries. */
      readonly receipt?: LaneReceipt;
      /** One line naming a receipt that is not the tip's own, for `dori done`'s output. */
      readonly via?: string;
    }
  | { readonly ok: false; readonly reason: string; readonly headUnreadable?: true };

/** The parents of one merge commit; empty when the checkout cannot answer or the commit is not a merge. */
async function mergeParents(d: Deps, repo: string, sha: string): Promise<string[]> {
  const out = await gitOut(d, repo, ["rev-list", "--parents", "-n", "1", sha]);
  if (out === undefined) return [];
  const [, ...parents] = out.trim().split(/\s+/);
  return parents.length > 1 ? parents : [];
}

/**
 * The receipt of work this lane already landed, for a tip that has none: a parent of the merge commit that carried the
 * lane (a `git rebase main` after the PR merge moves the lane tip onto that commit), or a receipted tip the main
 * checkout already contains. Every candidate is resolved with laneReceiptFor, so a same-patch BLOCK outranks a CLEAR
 * exactly as it does at the tip; a refused candidate is returned to be surfaced, never skipped for an older CLEAR.
 */
async function landedReceipt(
  d: Deps,
  lane: Lane,
  tip: string,
): Promise<{ readonly kind: "clear" | "refused"; readonly receipt: LaneReceipt; readonly via: string } | undefined> {
  const repo = lane.repo;
  if (repo === undefined) return undefined;
  const trunk = await gitOut(d, repo, ["rev-parse", "HEAD"]);
  const merges = trunk !== undefined && trunk !== tip ? [tip, trunk] : [tip];
  const parents: { readonly receipt: LaneReceipt; readonly via: string }[] = [];
  for (const merge of merges) {
    for (const parent of await mergeParents(d, laneRepo(lane), merge)) {
      const receipt = await laneReceiptFor(d, lane, parent);
      if (receipt === undefined) continue;
      parents.push({
        receipt,
        via:
          receipt.tip === parent
            ? `CLEAR receipt lane_${lane.key}@${parent} on the parent of merge commit ${merge}`
            : `CLEAR receipt lane_${lane.key}@${receipt.tip} covering the parent ${parent} of merge commit ${merge}`,
      });
    }
  }
  const refusedParent = parents.find((p) => p.receipt.verdict !== "CLEAR");
  if (refusedParent !== undefined)
    return {
      kind: "refused",
      receipt: refusedParent.receipt,
      via: `the lane receipt on the parent of merge commit is lane_${lane.key}@${refusedParent.receipt.tip}`,
    };
  const clearParent = parents.find((p) => p.receipt.verdict === "CLEAR");
  if (clearParent !== undefined) return { kind: "clear", ...clearParent };
  for (const receipt of d.store.receipts.laneReceipts(lane.key)) {
    if (receipt.verdict !== "CLEAR") continue;
    const ancestor = await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", receipt.tip, trunk ?? "HEAD"]);
    if (ancestor.code !== 0) continue;
    const covering = await laneReceiptFor(d, lane, receipt.tip);
    if (covering === undefined) continue;
    if (covering.verdict !== "CLEAR")
      return {
        kind: "refused",
        receipt: covering,
        via:
          `the CLEAR receipt lane_${lane.key}@${receipt.tip} already on main is overridden by ` +
          `lane_${lane.key}@${covering.tip} (${covering.verdict})`,
      };
    return { kind: "clear", receipt: covering, via: `CLEAR receipt lane_${lane.key}@${receipt.tip} already on main` };
  }
  return undefined;
}

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
  if (tip === lane.baseSha) return { ok: true, tip };
  const receipt = await laneReceiptFor(d, lane, tip);
  // The tip may be the merge commit that landed the lane: the receipt sits on the reviewed commit it merged.
  const landed = receipt === undefined ? await landedReceipt(d, lane, tip) : undefined;
  if (landed?.kind === "clear") return { ok: true, tip, receipt: landed.receipt, via: landed.via };
  if (landed?.kind === "refused")
    return {
      ok: false,
      reason:
        `lane ${lane.key} at ${tip.slice(0, 12)} is ${landed.receipt.verdict}: ${landed.via}; ` +
        `run dori review --lane ${lane.key} to review the current diff, then attest the reviewer verdict ` +
        `(or dori done --drop ${lane.key} --reason <text>)`,
    };
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
        `run the review in its own session with dori review <owner/repo#N> --background, then record the verdict with ` +
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
        `then run dori review <owner/repo#N> --background and attest the reviewer verdict (or dori done --drop ${lane.key} --reason <text>)`,
    };
  }
  return { ok: true, tip, receipt };
}

/** `reviewed`, `queued`, a non-CLEAR verdict or `no receipt` for one lane row in `dori status`. */
export async function reviewLabel(d: Deps, lane: Lane): Promise<string> {
  if (lane.baseSha === undefined) return "no receipt";
  const tip = (await laneHead(d, lane)) ?? lane.tipSha;
  if (tip === undefined) return "no receipt";
  let receipt: LaneReceipt | undefined;
  try {
    receipt = await laneReceiptFor(d, lane, tip);
  } catch {
    return "unreadable";
  }
  if (!receipt) {
    const job = reviewJobFor(d.store.root, lane.key, tip);
    if (job === "corrupt") return "unreadable";
    return job !== undefined ? "queued" : "no receipt";
  }
  return receipt.verdict === "CLEAR" ? "reviewed" : receipt.verdict;
}
