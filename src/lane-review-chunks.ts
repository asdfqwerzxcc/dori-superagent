// The chunked half of a lane review: a per-chunk deadline inside one job budget, a live `review_partial` receipt, and
// checkpointed answers so a retry pays only for the chunks that did not answer.

import type { Deps } from "./harness.ts";
import { saveChunkOutcome } from "./lane-review-final.ts";
import { attemptChunk } from "./review-attempt.ts";
import { loadResume } from "./review-checkpoint.ts";
import { resplitChunk, type DiffChunk } from "./review-chunks.ts";
import type { RetryFacts, ReviewDiagnostic } from "./review-diagnostic.ts";
import { stopOnKillFailure } from "./review-kill-stop.ts";
import { failed, type LaneResult, type LaneRun, outcomeState } from "./review-report.ts";
import {
  markNotRun,
  progressUnits,
  savePartialReceipt,
  unitOf,
  unitRow,
  updateUnit,
  type ProgressUnit,
} from "./review-progress.ts";

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
  readonly diagnose: (result: LaneResult, retry?: RetryFacts) => { diagnostic: ReviewDiagnostic; path: string };
  readonly reviewerField: (results: readonly LaneResult[]) => string;
  /** Throws when the queue job this run belongs to was replaced or cancelled. */
  readonly checkLive: () => void;
};

/** Reviews every chunk under one job budget; a failed chunk does not end the job, and a completed verdict is fenced. */
export async function reviewChunks(ctx: ChunkReviewContext): Promise<"CLEAR" | "BLOCK"> {
  const deadline = Date.now() + ctx.budgetMs;
  const budgetLeft = (): number => deadline - Date.now();
  const units: ProgressUnit[] = progressUnits(ctx.runs);
  const results: LaneResult[] = [];
  const savePartial = async (): Promise<void> => {
    await savePartialReceipt({
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
  /** Set by the first primary failure that names a dead provider; later chunks skip the primary entirely. */
  let primaryDown: { cause: string } | undefined;
  const fallback = ctx.fallback;
  let killFailure: string | undefined;

  await savePartial();
  const queue = [...ctx.runs];
  for (let i = 0; i < queue.length; i++) {
    const run = queue[i]!;
    const left = budgetLeft();
    if (left <= 0) {
      budgetHit = true;
      markNotRun(units, "job budget exhausted");
      await savePartial();
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
      await savePartial();
      continue;
    }
    updateUnit(units, run, {
      state: "running",
      note: undefined,
      ...(ctx.chosen === undefined ? {} : { model: ctx.chosen }),
    });
    await savePartial();
    const window = Math.min(ctx.timeoutMs, left);
    const windowBudgetBound = left <= ctx.timeoutMs;
    const chunkDeadline = Date.now() + window;
    const outcome = await attemptChunk(
      {
        run,
        chosen: ctx.chosen,
        fallback,
        deadline: chunkDeadline,
        attemptMs: ctx.attemptMs,
        attempt: ctx.attempt,
        diagnose: ctx.diagnose,
        checkLive: ctx.checkLive,
        canResplit: (r) =>
          r.outcome.kind === "exit" &&
          r.outcome.code === 0 &&
          r.outcome.stdout.trim() === "" &&
          run.chunk !== undefined &&
          run.resplit !== true &&
          resplitChunk(run.chunk).length > 1 &&
          budgetLeft() > 0,
      },
      primaryDown,
    );
    if (outcome.primaryDown !== undefined) primaryDown = outcome.primaryDown;
    const stopWhy = await stopOnKillFailure(outcome.result, run, units, results, savePartial);
    if (stopWhy !== undefined) {
      killFailure = stopWhy;
      break;
    }
    if (outcome.kind === "resplit") {
      const result = outcome.result;
      const chunk = run.chunk!;
      const subChunks = resplitChunk(chunk);
      const parent = ctx.diagnose(result);
      const parentUnit = unitOf(units, run);
      if (parentUnit !== undefined) {
        parentUnit.state = "empty";
        if (result.model !== undefined) parentUnit.model = result.model;
        parentUnit.durationMs = result.outcome.durationMs;
        parentUnit.note = `re-split into ${subChunks.length} sub-chunks`;
        if (primaryDown !== undefined) parentUnit.primaryDown = true;
      }
      notes.push(
        `--- re-split ${run.label} [${chunk.label ?? chunk.paths.join(", ")}] after empty output; ${subChunks.length} sub-chunks; diagnostic ${parent.path}${result.retryDiagnostic === undefined ? "" : `; primary diagnostic ${result.retryDiagnostic}`}`,
      );
      const parentRef = run.parent ?? { index: chunk.index, total: run.chunkTotal ?? ctx.runs.length };
      const subs = subChunks.map((sub) => ctx.chunkRun(sub, subChunks.length, true, parentRef));
      const at = units.findIndex((unit) => unit.run === run);
      units.splice(at + 1, 0, ...subs.map((sub) => ({ run: sub, state: "pending" as const })));
      queue.splice(i + 1, 0, ...subs);
      await savePartial();
      continue;
    }
    const { result, skippedPrimary, retriedOnFallback } = outcome;
    results.push(result);
    const note =
      result.outcome.kind === "error"
        ? `error: ${result.outcome.message}`
        : retriedOnFallback && primaryDown !== undefined
          ? skippedPrimary
            ? `primary down: ${primaryDown.cause}; used ${fallback}`
            : `primary down: ${primaryDown.cause}`
          : undefined;
    updateUnit(units, run, {
      state: outcomeState(result),
      ...(result.model === undefined
        ? ctx.chosen === undefined
          ? {}
          : { model: ctx.chosen }
        : { model: result.model }),
      durationMs: result.outcome.durationMs,
      ...(note === undefined ? {} : { note }),
      ...(retriedOnFallback && primaryDown !== undefined ? { primaryDown: true as const } : {}),
    });
    if (!failed(result)) {
      const unit = unitOf(units, run);
      resume.remember(run, result, unit === undefined ? run.label : unitRow(unit).label);
      await savePartial();
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
    await savePartial();
  }

  return saveChunkOutcome({
    d: ctx.d,
    key: ctx.key,
    base: ctx.base,
    tip: ctx.tip,
    brief: ctx.brief,
    logPath: ctx.logPath,
    reviewerField: ctx.reviewerField,
    units,
    results,
    notes,
    failureDiagnostics,
    firstFailure,
    budgetHit,
    killFailure,
  });
}
