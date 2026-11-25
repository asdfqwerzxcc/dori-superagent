// Which lane receipt covers a tip after a rebase moved its SHA: the exact-tip receipt, or one whose git patch-id still
// matches the current base..tip. Patch identity is what a reviewer judged; commit identity moves on every rebase.

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

/** Patch identity of a lane's `base..tip`: survives a clean rebase, changes when the patch content changes. */
export async function lanePatchId(d: Deps, repo: string, base: string, tip: string): Promise<string | undefined> {
  const diff = await laneGit(d, repo, [
    "--no-pager",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--binary",
    `${base}..${tip}`,
  ]);
  if (diff.code !== 0) return undefined;
  return patchIdOfDiff(d, diff.stdout);
}

/**
 * The receipt that covers `tip`: the exact tip first, else the newest receipt for the same patch. A BLOCK for the same
 * patch beats a CLEAR: content that was refused stays refused when only its SHA moved.
 */
export function pickLaneReceipt(
  receipts: readonly LaneReceipt[],
  tip: string,
  patchId: string | undefined,
): LaneReceipt | undefined {
  const exact = receipts.find((r) => r.tip === tip);
  if (exact !== undefined) return exact;
  if (patchId === undefined) return undefined;
  const same = receipts.filter((r) => r.patchId === patchId);
  if (same.length === 0) return undefined;
  const blocked = same.filter((r) => r.verdict === "BLOCK");
  return (blocked.length > 0 ? blocked : same).sort((a, b) => b.at - a.at)[0];
}

/** The receipt covering the lane's current `tip`, computing the patch-id only when an older receipt could cover it. */
export async function laneReceiptFor(d: Deps, lane: Lane, tip: string): Promise<LaneReceipt | undefined> {
  const receipts = d.store.receipts.laneReceipts(lane.key);
  const exact = receipts.find((r) => r.tip === tip);
  if (exact !== undefined) return exact;
  if (receipts.length === 0 || lane.baseSha === undefined) return undefined;
  const patchId = await lanePatchId(d, laneRepo(lane), lane.baseSha, tip);
  return pickLaneReceipt(receipts, tip, patchId);
}
