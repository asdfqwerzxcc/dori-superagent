// Which lane receipt covers a tip after a rebase moved its SHA: the exact-tip receipt, or one whose patch identity
// still matches the current base..tip. Two identities are recorded: `git patch-id --stable` (the id older receipts
// carry) and `--verbatim`, which keeps whitespace significant so a whitespace-only edit can never reuse a receipt
// written for another diff.

import { readFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { laneGit, laneRepo } from "./lane-repo.ts";
import { jobPath, readJob } from "./review-job.ts";
import type { Lane, LaneReceipt } from "./store-types.ts";

const PATCH_ID_RE = /^[0-9a-f]{40,64}$/;
const DIFF_ARGS = ["--no-pager", "diff", "--no-color", "--no-ext-diff"] as const;

/** Both identities of one diff: `patchId` (--stable) and `contentId` (--verbatim, whitespace included). */
export type PatchIds = { readonly patchId: string; readonly contentId: string };

/** `git patch-id <flag>` of one diff text. Undefined when there is nothing to hash or git cannot answer. */
async function idOfDiff(d: Deps, diff: string, flag: "--stable" | "--verbatim"): Promise<string | undefined> {
  if (diff.trim() === "") return undefined;
  const r = await d.exec("git", ["patch-id", flag], { stdin: diff });
  if (r.code !== 0) return undefined;
  const id = r.stdout.trim().split(/\s+/)[0];
  return id !== undefined && PATCH_ID_RE.test(id) ? id : undefined;
}

/** `git patch-id --stable`: whitespace-insensitive, the id receipts written before `contentId` carry. */
export const patchIdOfDiff = (d: Deps, diff: string): Promise<string | undefined> => idOfDiff(d, diff, "--stable");

/** `git patch-id --verbatim`: whitespace included, so only the same bytes of change share this id. */
export const contentIdOfDiff = (d: Deps, diff: string): Promise<string | undefined> => idOfDiff(d, diff, "--verbatim");

/** Both ids of one diff; undefined when one cannot be computed, so no receipt is ever bound on half an identity. */
export async function patchIdsOfDiff(d: Deps, diff: string): Promise<PatchIds | undefined> {
  const [patchId, contentId] = await Promise.all([patchIdOfDiff(d, diff), contentIdOfDiff(d, diff)]);
  return patchId === undefined || contentId === undefined ? undefined : { patchId, contentId };
}

/** The full `base..tip` diff of a checkout, or undefined when git cannot produce it. */
export async function laneDiff(d: Deps, repo: string, base: string, tip: string): Promise<string | undefined> {
  const diff = await laneGit(d, repo, [...DIFF_ARGS, `${base}..${tip}`]);
  return diff.code === 0 ? diff.stdout : undefined;
}

/** Both identities of a lane's `base..tip`; undefined for an empty/net-zero diff or when git cannot answer. */
export async function lanePatchIds(d: Deps, repo: string, base: string, tip: string): Promise<PatchIds | undefined> {
  const diff = await laneDiff(d, repo, base, tip);
  return diff === undefined ? undefined : patchIdsOfDiff(d, diff);
}

/** The saved review diff for `key@tip`, or undefined when the file is missing or unreadable. */
function savedDiff(d: Deps, key: string, tip: string): string | undefined {
  try {
    return readFileSync(d.store.laneDiffPath(key, tip), "utf8");
  } catch {
    return undefined;
  }
}

/** The base the saved diff for `reviewedTip` was generated from: its request, its receipt, or the current base. */
function savedBase(d: Deps, lane: Lane, reviewedTip: string, tip: string, base: string): string | undefined {
  const job = readJob(jobPath(d.store.root, lane.key, reviewedTip));
  if (job !== undefined) return job.base;
  const receipt = d.store.receipts.laneReceipts(lane.key).find((r) => r.tip === reviewedTip);
  if (receipt !== undefined) return receipt.base;
  return reviewedTip === tip ? base : undefined;
}

/**
 * True when the saved diff is the diff git produces for its recorded range, false when the file was edited, and
 * undefined when that range cannot be reproduced (no recorded base, or the commits are gone).
 */
async function savedDiffFromGit(
  d: Deps,
  lane: Lane,
  repo: string,
  saved: string,
  reviewedTip: string,
  tip: string,
  base: string,
): Promise<boolean | undefined> {
  const from = savedBase(d, lane, reviewedTip, tip, base);
  if (from === undefined) return undefined;
  const fresh = await laneDiff(d, repo, from, reviewedTip);
  return fresh === undefined ? undefined : fresh === saved;
}

/** The saved review diff an attestation rests on, or why there is none. */
export type ReviewBinding =
  | { readonly ok: true; readonly reviewedTip: string }
  | {
      readonly ok: false;
      readonly reason: "no-review" | "stale-diff" | "tampered-diff" | "whitespace-only" | "other-patch";
      readonly tips: readonly string[];
    };

/**
 * Binds an attestation to a saved review diff: the diff at the current tip, or one at an older tip whose patch ids
 * are the same in both forms. A saved diff whose stable id matches but whose whitespace-sensitive id does not is
 * refused as a whitespace-only change, and a file that is not the diff git produces is refused as tampered. A saved diff
 * at the current tip that disagrees is refused, never skipped: the file and the lane disagree, so only a new review
 * is safe.
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
  for (const reviewedTip of ordered) {
    const saved = savedDiff(d, lane.key, reviewedTip);
    if (saved === undefined) continue;
    const savedIds = await patchIdsOfDiff(d, saved);
    if (savedIds === undefined) continue;
    if (savedIds.patchId !== ids.patchId) continue;
    if (savedIds.contentId !== ids.contentId) {
      whitespace = true;
      continue;
    }
    if ((await savedDiffFromGit(d, lane, repo, saved, reviewedTip, tip, base)) === false) {
      if (reviewedTip === tip) tampered = true;
      continue;
    }
    return { ok: true, reviewedTip };
  }
  if (tips.length === 0) return { ok: false, reason: "no-review", tips };
  if (whitespace) return { ok: false, reason: "whitespace-only", tips };
  return { ok: false, reason: tampered ? "tampered-diff" : "other-patch", tips };
}

/**
 * The receipt that covers `tip`: a BLOCK for the same patch first, then the exact tip, then the newest same-patch
 * receipt. "Same patch" means both ids when `contentId` is known; a receipt written before `contentId` existed covers
 * only its exact tip. Content that was refused stays refused when only its SHA moved, even if the exact tip has an
 * older CLEAR.
 */
export function pickLaneReceipt(
  receipts: readonly LaneReceipt[],
  tip: string,
  patchId: string | undefined,
  contentId?: string,
): LaneReceipt | undefined {
  const same =
    patchId === undefined
      ? []
      : receipts.filter(
          (r) =>
            r.patchId === patchId &&
            (contentId === undefined || (r.contentId !== undefined && r.contentId === contentId)),
        );
  const blocked = same.filter((r) => r.verdict === "BLOCK");
  if (blocked.length > 0) return blocked.sort((a, b) => b.at - a.at)[0];
  const exact = receipts.find((r) => r.tip === tip);
  return exact ?? same.sort((a, b) => b.at - a.at)[0];
}

/**
 * The receipt covering the lane's current `tip`; a same-patch BLOCK is checked even when the exact tip has a CLEAR.
 * A tip whose diff cannot be hashed (an empty or net-zero patch) falls back to its exact receipt: there is no other
 * patch it could be confused with, and the exact receipt is the only statement about it.
 */
export async function laneReceiptFor(d: Deps, lane: Lane, tip: string): Promise<LaneReceipt | undefined> {
  const receipts = d.store.receipts.laneReceipts(lane.key);
  const exact = receipts.find((r) => r.tip === tip);
  if (receipts.length === 0 || lane.baseSha === undefined) return exact;
  const hasPatch = receipts.some((r) => r.patchId !== undefined);
  if (!hasPatch) return exact;
  if (exact !== undefined && exact.verdict !== "CLEAR") return exact;
  const hasBlock = receipts.some((r) => r.verdict === "BLOCK" && r.patchId !== undefined);
  if (exact !== undefined && !hasBlock) return exact;
  const repo = laneRepo(lane);
  let ids = await lanePatchIds(d, repo, lane.baseSha, tip);
  // A lane whose worktree is gone still has its commits in the landing repo; a landed close and the bundle gate read it.
  if (ids === undefined && lane.repo !== undefined && lane.repo !== repo)
    ids = await lanePatchIds(d, lane.repo, lane.baseSha, tip);
  if (ids === undefined) return exact;
  return pickLaneReceipt(receipts, tip, ids.patchId, ids.contentId);
}
