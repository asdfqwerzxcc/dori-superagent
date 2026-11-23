// The chunked runner's ending: a verdict from every chunk's result, the fenced receipt write, and the refusal that names
// the failing chunk's diagnostic.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { clearCheckpoint } from "./review-checkpoint.ts";
import { diagnosticLine, type ReviewDiagnostic } from "./review-diagnostic.ts";
import { chunkRows, progressPath, saveFinalReceipt, type ProgressUnit } from "./review-progress.ts";
import { failed, failureSummary, type LaneResult, successSummary } from "./review-report.ts";
import type { LaneVerdict } from "./store-types.ts";

export type ChunkOutcomeArgs = {
  readonly d: Deps;
  readonly key: string;
  readonly base: string;
  readonly tip: string;
  readonly brief: string;
  readonly logPath: string;
  readonly reviewerField: (results: readonly LaneResult[]) => string;
  readonly units: readonly ProgressUnit[];
  readonly results: readonly LaneResult[];
  readonly notes: readonly string[];
  readonly failureDiagnostics: readonly { readonly label: string; readonly path: string }[];
  readonly firstFailure: { readonly diagnostic: ReviewDiagnostic; readonly path: string } | undefined;
  readonly budgetHit: boolean;
};

/** Decides the final chunked verdict, saves it without downgrading a completed one, and refuses on an incomplete review. */
export async function saveChunkOutcome(args: ChunkOutcomeArgs): Promise<"CLEAR" | "BLOCK"> {
  const rows = chunkRows(args.units);
  const failedResults = args.results.filter(failed);
  const timedOut = args.budgetHit || failedResults.some((r) => r.outcome.kind === "timeout");
  const emptyFailure = failedResults.some((r) => r.outcome.kind === "exit" && r.outcome.stdout.trim() === "");
  const anyBlock = args.results.some((r) => r.verdict === "BLOCK");
  const verdict: LaneVerdict = anyBlock
    ? "BLOCK"
    : timedOut
      ? "reviewer_timeout"
      : emptyFailure
        ? "reviewer_empty"
        : failedResults.length > 0
          ? "review_partial"
          : "CLEAR";
  const summary =
    failedResults.length === 0
      ? successSummary(args.results, args.notes, rows)
      : failureSummary(args.results, args.firstFailure?.path ?? "", args.notes, rows, args.failureDiagnostics);
  const saved = await saveFinalReceipt({
    d: args.d,
    key: args.key,
    tip: args.tip,
    receipt: {
      lane: args.key,
      verdict,
      base: args.base,
      tip: args.tip,
      brief: args.brief,
      reviewer: args.reviewerField(args.results),
      at: args.d.now(),
      summary,
      chunks: rows,
    },
  });
  if (verdict !== "CLEAR" && verdict !== "BLOCK") {
    const first = args.firstFailure;
    const why =
      verdict === "reviewer_timeout"
        ? `review of lane ${args.key} at ${args.tip} is incomplete: a chunk timed out${args.budgetHit ? " or the job budget ran out" : ""}`
        : verdict === "reviewer_empty"
          ? `review of lane ${args.key} at ${args.tip} is incomplete: a chunk printed no output`
          : `review of lane ${args.key} at ${args.tip} is incomplete: a chunk failed without a verdict`;
    const where =
      saved.where === "sidecar"
        ? `; this job's verdict is ${verdict}, the canonical receipt stays ${saved.kept}, and its failure is in ${progressPath(args.d.store.root, args.key, args.tip)}`
        : `; receipt lane_${args.key}@${args.tip} says ${verdict} with every chunk's state`;
    throw new Refusal(
      `${why}${where}${first === undefined ? "" : `; diagnostic ${diagnosticLine(first.diagnostic)}`}; output saved to ${args.logPath}${first === undefined ? "" : `; ${first.path}`}`,
    );
  }
  if (saved.where === "sidecar") {
    if (saved.kept === "CLEAR" || saved.kept === "BLOCK") {
      clearCheckpoint(args.d.store.root, args.key, args.tip);
      return saved.kept;
    }
    throw new Refusal(
      `review of lane ${args.key} at ${args.tip} was preempted by a newer writer; the canonical receipt is ${saved.kept}; this job's ${verdict} is in ${progressPath(args.d.store.root, args.key, args.tip)}`,
    );
  }
  clearCheckpoint(args.d.store.root, args.key, args.tip);
  return verdict;
}
