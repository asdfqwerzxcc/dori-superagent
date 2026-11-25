// Which lane receipt covers a tip after a rebase moved its SHA: the exact-tip receipt, or one whose git patch-id still
// matches the current base..tip. Patch identity is what a reviewer judged; commit identity moves on every rebase.

import { readFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { laneGit, laneRepo } from "./lane-repo.ts";
import type { Lane, LaneReceipt } from "./store-types.ts";

const PATCH_ID_RE = /^[0-9a-f]{40,64}$/;

/** `git patch-id --stable` of one diff text. Undefined when there is nothing to hash or git cannot answer. */
export async function patchIdOfDiff(d: Deps, diff: string): Promise<string | undefined> {
  if (diff.trim() === "") return undefined;
  const r = await d.exec("git", ["patch-id", "--stable"], { stdin: diff });
  if (r.code !== 0) return undefined;
  const id = r.stdout.trim().split(/\s+/)[0];
  return id !== undefined && PATCH_ID_RE.test(id) ? id : undefined;
}

/** Patch identity of a lane's `base..tip`: survives a rebase that leaves the diff unchanged, changes with content. */
export async function lanePatchId(d: Deps, repo: string, base: string, tip: string): Promise<string | undefined> {
  const diff = await laneGit(d, repo, ["--no-pager", "diff", "--no-color", "--no-ext-diff", `${base}..${tip}`]);
  if (diff.code !== 0) return undefined;
  return patchIdOfDiff(d, diff.stdout);
}

/** Patch-id of the saved review diff for `key@tip`; undefined when the file is missing or empty. */
export async function reviewedDiffPatchId(d: Deps, key: string, tip: string): Promise<string | undefined> {
  let diff: string;
  try {
    diff = readFileSync(d.store.laneDiffPath(key, tip), "utf8");
  } catch {
    return undefined;
  }
  return patchIdOfDiff(d, diff);
}

/** The saved review diff an attestation is allowed to rest on, or why there is none. */
export type ReviewBinding =
  | { readonly ok: true; readonly reviewedTip: string }
  | {
      readonly ok: false;
      readonly reason: "no-review" | "stale-diff" | "other-patch";
      readonly tips: readonly string[];
    };

/**
 * Binds an attestation to a saved review diff: the diff at the current tip, or one at an older tip whose patch-id is
 * the same. A saved diff at the current tip that disagrees is refused, never skipped: the file and the lane disagree,
 * so only a new review is safe.
 */
export async function reviewBinding(d: Deps, lane: Lane, tip: string, patchId: string): Promise<ReviewBinding> {
  const tips = d.store.receipts.laneDiffTips(lane.key);
  if (tips.includes(tip)) {
    const saved = await reviewedDiffPatchId(d, lane.key, tip);
    return saved === patchId ? { ok: true, reviewedTip: tip } : { ok: false, reason: "stale-diff", tips };
  }
  for (const reviewedTip of tips) {
    if ((await reviewedDiffPatchId(d, lane.key, reviewedTip)) === patchId) return { ok: true, reviewedTip };
  }
  return { ok: false, reason: tips.length === 0 ? "no-review" : "other-patch", tips };
}

/**
 * The receipt that covers `tip`: a BLOCK for the same patch first, then the exact tip, then the newest same-patch
 * receipt. Content that was refused stays refused when only its SHA moved, even if the exact tip has an older CLEAR.
 */
export function pickLaneReceipt(
  receipts: readonly LaneReceipt[],
  tip: string,
  patchId: string | undefined,
): LaneReceipt | undefined {
  const same = patchId === undefined ? [] : receipts.filter((r) => r.patchId === patchId);
  const blocked = same.filter((r) => r.verdict === "BLOCK");
  if (blocked.length > 0) return blocked.sort((a, b) => b.at - a.at)[0];
  const exact = receipts.find((r) => r.tip === tip);
  return exact ?? same.sort((a, b) => b.at - a.at)[0];
}

/** The receipt covering the lane's current `tip`; a same-patch BLOCK is checked even when the exact tip has a CLEAR. */
export async function laneReceiptFor(d: Deps, lane: Lane, tip: string): Promise<LaneReceipt | undefined> {
  const receipts = d.store.receipts.laneReceipts(lane.key);
  const exact = receipts.find((r) => r.tip === tip);
  if (receipts.length === 0 || lane.baseSha === undefined) return exact;
  const hasPatch = receipts.some((r) => r.patchId !== undefined);
  if (!hasPatch) return exact;
  const hasBlock = receipts.some((r) => r.verdict === "BLOCK" && r.patchId !== undefined);
  if (exact !== undefined && (exact.verdict !== "CLEAR" || !hasBlock)) return exact;
  const repo = laneRepo(lane);
  let patchId = await lanePatchId(d, repo, lane.baseSha, tip);
  // A lane whose worktree is gone still has its commits in the landing repo; a landed close and the bundle gate read it.
  if (patchId === undefined && lane.repo !== undefined && lane.repo !== repo)
    patchId = await lanePatchId(d, lane.repo, lane.baseSha, tip);
  if (patchId === undefined) return undefined;
  return pickLaneReceipt(receipts, tip, patchId);
}
