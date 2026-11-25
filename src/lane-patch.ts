// Which lane receipt covers a tip after a rebase moved its SHA: the exact-tip receipt, or one whose patch identity
// still matches the current base..tip. Two identities are recorded: `git patch-id --stable` (the id older receipts
// carry) and `--verbatim`, which keeps whitespace significant so a whitespace-only edit can never reuse a receipt
// written for another diff. A legacy BLOCK carries no content id and therefore blocks every whitespace variant of its
// patch; a legacy CLEAR covers only its exact tip.

import type { Deps } from "./harness.ts";
import { laneGit, laneRepo } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import type { Lane, LaneReceipt } from "./store-types.ts";

const PATCH_ID_RE = /^[0-9a-f]{40,64}$/;
const DIFF_ARGS = ["--no-pager", "diff", "--no-color", "--no-ext-diff"] as const;
const UNSUPPORTED_VERBATIM_RE = /unknown option|unrecognized option|invalid option|usage:/i;

const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";
const parseId = (stdout: string): string | undefined => {
  const id = stdout.trim().split(/\s+/)[0];
  return id !== undefined && PATCH_ID_RE.test(id) ? id : undefined;
};

/** Both identities of one diff: `patchId` (--stable) and `contentId` (--verbatim, whitespace included). */
export type PatchIds = { readonly patchId: string; readonly contentId: string };

/** What can be learned from one diff: both ids, nothing to hash, or why git could not answer. */
export type PatchIdentity =
  | { readonly kind: "ok"; readonly ids: PatchIds }
  | { readonly kind: "empty" }
  | { readonly kind: "unsupported-verbatim"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string };

/** Both ids of one diff. A git without `patch-id --verbatim` is named instead of silently falling back to --stable. */
export async function patchIdentity(d: Deps, diff: string): Promise<PatchIdentity> {
  if (diff.trim() === "") return { kind: "empty" };
  const stable = await d.exec("git", ["patch-id", "--stable"], { stdin: diff });
  if (stable.code !== 0)
    return { kind: "failed", why: `git patch-id --stable: ${firstLine(stable.stderr) || "no output"}` };
  const verbatim = await d.exec("git", ["patch-id", "--verbatim"], { stdin: diff });
  if (verbatim.code !== 0) {
    const why = firstLine(verbatim.stderr) || firstLine(verbatim.stdout) || "no output";
    return UNSUPPORTED_VERBATIM_RE.test(why)
      ? { kind: "unsupported-verbatim", why }
      : { kind: "failed", why: `git patch-id --verbatim: ${why}` };
  }
  const patchId = parseId(stable.stdout);
  const contentId = parseId(verbatim.stdout);
  return patchId !== undefined && contentId !== undefined
    ? { kind: "ok", ids: { patchId, contentId } }
    : { kind: "failed", why: "git patch-id printed no usable id" };
}

/** The full `base..tip` diff of a checkout, or undefined when git cannot produce it. */
export async function laneDiff(d: Deps, repo: string, base: string, tip: string): Promise<string | undefined> {
  const diff = await laneGit(d, repo, [...DIFF_ARGS, `${base}..${tip}`]);
  return diff.code === 0 ? diff.stdout : undefined;
}

/** The diff plus both identities, or exactly why the gate cannot inspect the lane's range. */
export type LanePatch =
  | { readonly kind: "ok"; readonly diff: string; readonly ids: PatchIds }
  | { readonly kind: "empty" }
  | { readonly kind: "unsupported-verbatim"; readonly why: string }
  | { readonly kind: "failed"; readonly repo: string; readonly why: string };

export async function lanePatch(d: Deps, repo: string, base: string, tip: string): Promise<LanePatch> {
  const diff = await laneDiff(d, repo, base, tip);
  if (diff === undefined)
    return { kind: "failed", repo, why: `git diff ${base.slice(0, 12)}..${tip.slice(0, 12)} failed` };
  const identity = await patchIdentity(d, diff);
  switch (identity.kind) {
    case "ok":
      return { kind: "ok", diff, ids: identity.ids };
    case "empty":
      return identity;
    case "unsupported-verbatim":
      return identity;
    case "failed":
      return { kind: "failed", repo, why: identity.why };
  }
}

/** Both identities of a lane's `base..tip`; undefined for an empty/net-zero diff or any failure. */
export async function lanePatchIds(d: Deps, repo: string, base: string, tip: string): Promise<PatchIds | undefined> {
  const patch = await lanePatch(d, repo, base, tip);
  return patch.kind === "ok" ? patch.ids : undefined;
}

/**
 * The receipt that covers `tip`: a BLOCK for the same patch first, then the exact tip, then the newest same-patch
 * receipt. "Same patch" for a BLOCK includes a receipt with no `contentId`: a legacy BLOCK cannot name the whitespace
 * variant it saw, so it blocks every variant of that `patchId` until a review lands a different patch. A legacy CLEAR
 * covers only its exact tip. Content that was refused stays refused when only its SHA moved.
 */
export function pickLaneReceipt(
  receipts: readonly LaneReceipt[],
  tip: string,
  patchId: string | undefined,
  contentId?: string,
): LaneReceipt | undefined {
  const samePatch = patchId === undefined ? [] : receipts.filter((r) => r.patchId === patchId);
  const blocked = samePatch.filter(
    (r) => r.verdict === "BLOCK" && (contentId === undefined || r.contentId === undefined || r.contentId === contentId),
  );
  if (blocked.length > 0) return blocked.sort((a, b) => b.at - a.at)[0];
  const sameContent = samePatch.filter((r) => contentId === undefined || r.contentId === contentId);
  const exact = receipts.find((r) => r.tip === tip);
  return exact ?? sameContent.sort((a, b) => b.at - a.at)[0];
}

/** The lane's current diff, from its worktree first and the landing repo when the worktree is gone. */
async function lanePatchFor(d: Deps, lane: Lane, tip: string): Promise<LanePatch> {
  const repo = laneRepo(lane);
  const first = await lanePatch(d, repo, lane.baseSha!, tip);
  if (first.kind !== "failed") return first;
  if (lane.repo === undefined || lane.repo === repo) return first;
  const second = await lanePatch(d, lane.repo, lane.baseSha!, tip);
  return second.kind === "failed" ? first : second;
}

/**
 * The receipt covering the lane's current `tip`; a same-patch BLOCK is checked even when the exact tip has a CLEAR.
 * A tip whose diff is empty or net-zero falls back to its exact receipt: there is no other patch it could be confused
 * with. A git failure or a git without `patch-id --verbatim` throws instead of reading as "no diff" and must be fixed
 * before the gate can decide.
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
  const patch = await lanePatchFor(d, lane, tip);
  if (patch.kind === "failed")
    throw new Refusal(
      `lane ${lane.key} at ${tip.slice(0, 12)}: cannot inspect ${lane.baseSha.slice(0, 12)}..${tip.slice(0, 12)} ` +
        `in ${patch.repo} (${patch.why}); the review gate cannot decide, so the lane stays open. Fix the checkout, ` +
        `then retry`,
    );
  if (patch.kind === "unsupported-verbatim")
    throw new Refusal(
      `lane ${lane.key} at ${tip.slice(0, 12)}: this git does not support git patch-id --verbatim (${patch.why}); ` +
        `upgrade git so a whitespace-only change cannot reuse a receipt; the review gate cannot decide`,
    );
  if (patch.kind === "empty") return exact;
  return pickLaneReceipt(receipts, tip, patch.ids.patchId, patch.ids.contentId);
}
