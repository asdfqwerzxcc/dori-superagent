// The chunked half of a lane review: a per-chunk deadline inside one job budget, a live `review_partial` receipt, and
// checkpointed answers so a retry pays only for the chunks that did not answer.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { attemptSafely } from "./review-attempt.ts";
import { clearCheckpoint, loadResume } from "./review-checkpoint.ts";
import { resplitChunk, type DiffChunk } from "./review-chunks.ts";
import { diagnosticLine, type ReviewDiagnostic } from "./review-diagnostic.ts";
import {
  failed,
  failureKind,
  failureSummary,
  type LaneResult,
  type LaneRun,
  outcomeState,
  successSummary,
} from "./review-report.ts";
import {
  chunkRows,
  markNotRun,
  progressPath,
  progressUnits,
  saveFinalReceipt,
  savePartialReceipt,
  unitOf,
  unitRow,
  updateUnit,
  type ProgressUnit,
} from "./review-progress.ts";
import type { LaneVerdict } from "./store-types.ts";

/** What the chunked runner needs from `reviewLane`: the target, the plan, and the helpers that spawn and diagnose. */
export type ChunkReviewContext = {
  readonly d: Deps;
  readonly key: string;
  readonly brief: string;
  readonly base: string;
  readonly tip: string;
  readonly logPath: string;
  readonly chosen: string | undefined;
  readonly fallback: string | undefined;
  readonly reviewer: string;
  readonly timeoutMs: number;
  readonly attemptMs: number;
  readonly budgetMs: number;
  readonly runs: readonly LaneRun[];
  readonly chunkRun: (
    chunk: DiffChunk,
    total: number,
    resplit: boolean,
    parent?: { readonly index: number; readonly total: number },
  ) => LaneRun;
  readonly attempt: (run: LaneRun, model: string | undefined, limitMs: number) => Promise<LaneResult>;
  readonly diagnose: (result: LaneResult) => { diagnostic: ReviewDiagnostic; path: string };
  readonly reviewerField: (results: readonly LaneResult[]) => string;
};

/**
 * Reviews every chunk under one job budget. A failed or thrown chunk does not end the job (the others still answer and
 * the receipt says what is missing); a retry reuses the chunks that answered. A job never downgrades a completed
 * verdict: a failure is kept in the progress sidecar while a canonical CLEAR/BLOCK stays. Saves the final receipt and
 * throws when the review is incomplete, so `reviewLane` only has to record a completed verdict.
 */
export async function reviewChunks(ctx: ChunkReviewContext): Promise<"CLEAR" | "BLOCK"> {
  const deadline = Date.now() + ctx.budgetMs;
  const budgetLeft = (): number => deadline - Date.now();
  const units: ProgressUnit[] = progressUnits(ctx.runs);
  const results: LaneResult[] = [];
  const savePartial = (): void => {
    savePartialReceipt({
      d: ctx.d,
      key: ctx.key,
      tip: ctx.tip,
      base: ctx.base,
      brief: ctx.brief,
      reviewer: ctx.reviewerField(results),
      units,
    });
  };

  const resume = loadResume({
    root: ctx.d.store.root,
    lane: ctx.key,
    tip: ctx.tip,
    base: ctx.base,
    reviewer: ctx.reviewer,
    now: ctx.d.now,
  });

  const notes: string[] = [];
  const failureDiagnostics: { label: string; path: string }[] = [];
  let firstFailure: { diagnostic: ReviewDiagnostic; path: string } | undefined;
  let budgetHit = false;

  savePartial();
  const queue = [...ctx.runs];
  for (let i = 0; i < queue.length; i++) {
    const run = queue[i]!;
    const left = budgetLeft();
    if (left <= 0) {
      budgetHit = true;
      markNotRun(units, "job budget exhausted");
      savePartial();
      break;
    }
    const reused = resume.reuse(run);
    if (reused !== undefined) {
      // A checkpoint answer from the fallback still has to name the model that actually answered.
      if (reused.model !== undefined && reused.model !== ctx.chosen) reused.retried = "reused fallback answer";
      results.push(reused);
      updateUnit(units, run, {
        state: outcomeState(reused),
        ...(reused.model === undefined ? {} : { model: reused.model }),
        durationMs: reused.outcome.durationMs,
        reused: true,
        note: "from the previous attempt",
      });
      savePartial();
      continue;
    }
    updateUnit(units, run, {
      state: "running",
      note: undefined,
      ...(ctx.chosen === undefined ? {} : { model: ctx.chosen }),
    });
    savePartial();
    const window = Math.min(ctx.timeoutMs, left);
    const windowBudgetBound = left <= ctx.timeoutMs;
    const chunkDeadline = Date.now() + window;
    const slice = (): number => Math.max(1, Math.min(ctx.attemptMs, chunkDeadline - Date.now()));
    let result = await attemptSafely(() => ctx.attempt(run, ctx.chosen, slice()), run, ctx.chosen);
    const empty = result.outcome.kind === "exit" && result.outcome.stdout.trim() === "";
    if (empty && run.chunk !== undefined && run.resplit !== true && budgetLeft() > 0) {
      const subChunks = resplitChunk(run.chunk);
      if (subChunks.length > 1) {
        const parent = ctx.diagnose(result);
        const parentUnit = unitOf(units, run);
        if (parentUnit !== undefined) {
          parentUnit.state = "empty";
          if (result.model !== undefined) parentUnit.model = result.model;
          parentUnit.durationMs = result.outcome.durationMs;
          parentUnit.note = `re-split into ${subChunks.length} sub-chunks`;
        }
        notes.push(
          `--- re-split ${run.label} [${run.chunk.label ?? run.chunk.paths.join(", ")}] after empty output; ${subChunks.length} sub-chunks; diagnostic ${parent.path}`,
        );
        const parentRef = run.parent ?? { index: run.chunk.index, total: run.chunkTotal ?? ctx.runs.length };
        const subs = subChunks.map((chunk) => ctx.chunkRun(chunk, subChunks.length, true, parentRef));
        const at = units.findIndex((unit) => unit.run === run);
        units.splice(at + 1, 0, ...subs.map((sub) => ({ run: sub, state: "pending" as const })));
        queue.splice(i + 1, 0, ...subs);
        savePartial();
        continue;
      }
    }
    if (failed(result) && ctx.fallback !== undefined && ctx.fallback !== ctx.chosen && chunkDeadline > Date.now()) {
      const primary = result;
      const primaryDiag = ctx.diagnose(primary);
      const remaining = Math.max(1, Math.min(ctx.attemptMs, chunkDeadline - Date.now()));
      result = await attemptSafely(() => ctx.attempt(run, ctx.fallback, remaining), run, ctx.fallback);
      result.retried = `${primary.model ?? "default"} ${failureKind(primary)}`;
      result.retryDiagnostic = primaryDiag.path;
    }
    results.push(result);
    updateUnit(units, run, {
      state: outcomeState(result),
      ...(result.model === undefined
        ? ctx.chosen === undefined
          ? {}
          : { model: ctx.chosen }
        : { model: result.model }),
      durationMs: result.outcome.durationMs,
      ...(result.outcome.kind === "error" ? { note: `error: ${result.outcome.message}` } : {}),
    });
    if (!failed(result)) {
      const unit = unitOf(units, run);
      resume.remember(run, result, unit === undefined ? run.label : unitRow(unit).label);
      savePartial();
      continue;
    }
    const { diagnostic, path: diagPath } = ctx.diagnose(result);
    const unit = unitOf(units, run);
    failureDiagnostics.push({ label: unit === undefined ? run.label : unitRow(unit).label, path: diagPath });
    if (firstFailure === undefined) firstFailure = { diagnostic, path: diagPath };
    if (result.outcome.kind === "timeout" && windowBudgetBound && Date.now() >= chunkDeadline) {
      budgetHit = true;
      markNotRun(units, "job budget exhausted");
    }
    savePartial();
  }

  const rows = chunkRows(units);
  const failedResults = results.filter(failed);
  const timedOut = budgetHit || failedResults.some((r) => r.outcome.kind === "timeout");
  const emptyFailure = failedResults.some((r) => r.outcome.kind === "exit" && r.outcome.stdout.trim() === "");
  const verdict: LaneVerdict = timedOut
    ? "reviewer_timeout"
    : emptyFailure
      ? "reviewer_empty"
      : failedResults.length > 0
        ? "review_partial"
        : results.some((r) => r.verdict === "BLOCK")
          ? "BLOCK"
          : "CLEAR";
  const summary =
    failedResults.length === 0
      ? successSummary(results, notes, rows)
      : failureSummary(results, firstFailure?.path ?? "", notes, rows, failureDiagnostics);
  const saved = saveFinalReceipt({
    d: ctx.d,
    key: ctx.key,
    tip: ctx.tip,
    receipt: {
      lane: ctx.key,
      verdict,
      base: ctx.base,
      tip: ctx.tip,
      brief: ctx.brief,
      reviewer: ctx.reviewerField(results),
      at: ctx.d.now(),
      summary,
      chunks: rows,
    },
  });
  if (verdict !== "CLEAR" && verdict !== "BLOCK") {
    const first = firstFailure;
    const why =
      verdict === "reviewer_timeout"
        ? `review of lane ${ctx.key} at ${ctx.tip} is incomplete: a chunk timed out${budgetHit ? " or the job budget ran out" : ""}`
        : verdict === "reviewer_empty"
          ? `review of lane ${ctx.key} at ${ctx.tip} is incomplete: a chunk printed no output`
          : `review of lane ${ctx.key} at ${ctx.tip} is incomplete: a chunk failed without a verdict`;
    const where =
      saved.where === "sidecar"
        ? `; this job's verdict is ${verdict}, the canonical receipt stays ${saved.kept}, and its failure is in ${progressPath(ctx.d.store.root, ctx.key, ctx.tip)}`
        : `; receipt lane_${ctx.key}@${ctx.tip} says ${verdict} with every chunk's state`;
    throw new Refusal(
      `${why}${where}${first === undefined ? "" : `; diagnostic ${diagnosticLine(first.diagnostic)}`}; output saved to ${ctx.logPath}${first === undefined ? "" : `; ${first.path}`}`,
    );
  }
  clearCheckpoint(ctx.d.store.root, ctx.key, ctx.tip);
  return verdict;
}
