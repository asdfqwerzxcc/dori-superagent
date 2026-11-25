// Binding an attestation to the saved review diff: which tip's file the verdict rests on, whether it is the diff git
// produces for a recorded range, and whether the whitespace-sensitive identity still matches. A file with no recorded
// base whose range cannot be reproduced is unverified, never accepted by id alone.

import { readFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { laneDiff, patchIdentity, type PatchIds } from "./lane-patch.ts";
import { gitOut } from "./lane-repo.ts";
import { jobPath, readJob } from "./review-job.ts";
import type { Lane } from "./store-types.ts";

/** The saved review diff for `key@tip`, or undefined when the file is missing or unreadable. */
function savedDiff(d: Deps, key: string, tip: string): string | undefined {
  try {
    return readFileSync(d.store.laneDiffPath(key, tip), "utf8");
  } catch {
    return undefined;
  }
}

/** The base the saved diff for `reviewedTip` was generated from, from its request or a receipt that names it. */
function savedBase(d: Deps, lane: Lane, reviewedTip: string, tip: string, base: string): string | undefined {
  const job = readJob(jobPath(d.store.root, lane.key, reviewedTip));
  if (job !== undefined) return job.base;
  const receipts = d.store.receipts.laneReceipts(lane.key);
  const at = receipts.find((r) => r.tip === reviewedTip);
  if (at !== undefined) return at.base;
  const recorded = receipts.find((r) => r.reviewedTip === reviewedTip && r.reviewedBase !== undefined);
  if (recorded?.reviewedBase !== undefined) return recorded.reviewedBase;
  return reviewedTip === tip ? base : undefined;
}

/** The base a saved diff at `tip` was generated from, for the reviewer prompt: recorded first, else the merge-base. */
export async function savedDiffBase(d: Deps, lane: Lane, repo: string, tip: string): Promise<string | undefined> {
  const job = readJob(jobPath(d.store.root, lane.key, tip));
  if (job !== undefined) return job.base;
  const receipts = d.store.receipts.laneReceipts(lane.key);
  const at = receipts.find((r) => r.tip === tip);
  if (at !== undefined) return at.base;
  const recorded = receipts.find((r) => r.reviewedTip === tip && r.reviewedBase !== undefined);
  if (recorded?.reviewedBase !== undefined) return recorded.reviewedBase;
  if (lane.baseSha === undefined) return undefined;
  return gitOut(d, repo, ["merge-base", lane.baseSha, tip]);
}

type Provenance =
  | { readonly status: "ok"; readonly base: string }
  | { readonly status: "tampered"; readonly base: string }
  | { readonly status: "unverifiable" };

/** The saved diff must be the diff git produces for a recorded base; no recorded base is unverifiable, not accepted. */
async function provenance(
  d: Deps,
  lane: Lane,
  repo: string,
  saved: string,
  reviewedTip: string,
  tip: string,
  base: string,
): Promise<Provenance> {
  const from = savedBase(d, lane, reviewedTip, tip, base);
  if (from === undefined) return { status: "unverifiable" };
  const fresh = await laneDiff(d, repo, from, reviewedTip);
  if (fresh === undefined) return { status: "unverifiable" };
  return fresh === saved ? { status: "ok", base: from } : { status: "tampered", base: from };
}

/** The saved review diff an attestation rests on, or why there is none. */
export type ReviewBinding =
  | { readonly ok: true; readonly reviewedTip: string; readonly reviewedBase: string }
  | {
      readonly ok: false;
      readonly reason:
        | "no-review"
        | "tampered-diff"
        | "unverified-diff"
        | "unsupported-verbatim"
        | "whitespace-only"
        | "other-patch";
      readonly tips: readonly string[];
    };

/**
 * Binds an attestation to a saved review diff: the diff at the current tip, or one at an older tip whose patch ids
 * are the same in both forms. A saved diff whose stable id matches but whose whitespace-sensitive id does not is
 * refused as a whitespace-only change. A file that is not the diff git produces is refused as tampered, and a file
 * with no recorded base whose range git cannot reproduce is refused as unverified rather than accepted by id. A saved
 * diff at the current tip that disagrees is refused, never skipped: the file and the lane disagree, so only a new
 * review is safe.
 */
export async function reviewBinding(
  d: Deps,
  lane: Lane,
  repo: string,
  tip: string,
  base: string,
  ids: PatchIds,
): Promise<ReviewBinding> {
  const tips = d.store.receipts.laneDiffTips(lane.key);
  const ordered = [tip, ...tips.filter((t) => t !== tip)];
  let whitespace = false;
  let tampered = false;
  let unverified = false;
  for (const reviewedTip of ordered) {
    const saved = savedDiff(d, lane.key, reviewedTip);
    if (saved === undefined) continue;
    const identity = await patchIdentity(d, saved);
    if (identity.kind === "unsupported-verbatim") return { ok: false, reason: "unsupported-verbatim", tips };
    if (identity.kind !== "ok") {
      unverified = true;
      continue;
    }
    if (identity.ids.patchId !== ids.patchId) continue;
    if (identity.ids.contentId !== ids.contentId) {
      whitespace = true;
      continue;
    }
    const check = await provenance(d, lane, repo, saved, reviewedTip, tip, base);
    if (check.status === "tampered") {
      tampered = true;
      continue;
    }
    if (check.status === "unverifiable") {
      unverified = true;
      continue;
    }
    return { ok: true, reviewedTip, reviewedBase: check.base };
  }
  if (tips.length === 0) return { ok: false, reason: "no-review", tips };
  if (whitespace) return { ok: false, reason: "whitespace-only", tips };
  if (tampered) return { ok: false, reason: "tampered-diff", tips };
  return { ok: false, reason: unverified ? "unverified-diff" : "other-patch", tips };
}
