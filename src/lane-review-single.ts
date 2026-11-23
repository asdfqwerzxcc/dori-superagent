// The single-diff half of a lane review: one primary attempt, one fallback, and the same no-downgrade final save the
// chunked path uses. A thrown reviewer becomes a failed attempt, never an uncaught error.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { attemptSafely } from "./review-attempt.ts";
import { diagnosticLine, type ReviewDiagnostic } from "./review-diagnostic.ts";
import { failed, failureKind, failureSummary, type LaneResult, type LaneRun, successSummary } from "./review-report.ts";
import { saveFinalReceipt, progressPath } from "./review-progress.ts";
import type { LaneVerdict } from "./store-types.ts";

export type SingleFail = (
  verdict: Extract<LaneVerdict, "reviewer_timeout" | "reviewer_empty" | "review_partial">,
  summary: string,
  why: string,
  diagnostic: ReviewDiagnostic,
  diagPath: string,
  results: readonly LaneResult[],
) => Promise<never>;

/** What the single-diff runner needs from `reviewLane`: one run, the helpers, and the receipt writer. */
export type SingleReviewContext = {
  readonly d: Deps;
  readonly key: string;
  readonly brief: string;
  readonly base: string;
  readonly tip: string;
  readonly logPath: string;
  readonly chosen: string | undefined;
  readonly fallback: string | undefined;
  readonly timeoutMs: number;
  readonly budgetMs: number;
  readonly run: LaneRun;
  readonly attempt: (run: LaneRun, model: string | undefined, limitMs: number) => Promise<LaneResult>;
  readonly diagnose: (result: LaneResult) => { diagnostic: ReviewDiagnostic; path: string };
  readonly reviewerField: (results: readonly LaneResult[]) => string;
  readonly fail: SingleFail;
};

export async function reviewSingle(ctx: SingleReviewContext): Promise<"CLEAR" | "BLOCK"> {
  const deadline = Date.now() + ctx.budgetMs;
  const budgetLeft = (): number => Math.max(1, deadline - Date.now());
  const results: LaneResult[] = [];

  let result = await attemptSafely(
    () => ctx.attempt(ctx.run, ctx.chosen, Math.min(ctx.timeoutMs, budgetLeft())),
    ctx.run,
    ctx.chosen,
  );
  if (failed(result) && ctx.fallback !== undefined && ctx.fallback !== ctx.chosen && deadline > Date.now()) {
    const primary = result;
    const primaryDiag = ctx.diagnose(primary);
    result = await attemptSafely(
      () => ctx.attempt(ctx.run, ctx.fallback, Math.min(ctx.timeoutMs, budgetLeft())),
      ctx.run,
      ctx.fallback,
    );
    result.retried = `${primary.model ?? "default"} ${failureKind(primary)}`;
    result.retryDiagnostic = primaryDiag.path;
  }
  results.push(result);
  if (failed(result)) {
    const { diagnostic, path } = ctx.diagnose(result);
    const summary = failureSummary(results, path);
    const outcome = result.outcome;
    if (outcome.kind === "error")
      return ctx.fail(
        "review_partial",
        summary,
        `reviewer for lane ${ctx.key} threw: ${outcome.message}`,
        diagnostic,
        path,
        results,
      );
    if (outcome.kind === "timeout")
      return ctx.fail("reviewer_timeout", summary, `reviewer for lane ${ctx.key} timed out`, diagnostic, path, results);
    if (outcome.stdout.trim() === "")
      return ctx.fail(
        "reviewer_empty",
        summary,
        `reviewer for lane ${ctx.key} printed no output (exit ${outcome.code})`,
        diagnostic,
        path,
        results,
      );
    const why =
      outcome.code === 0
        ? "reviewer printed no VERDICT line"
        : `reviewer exited ${outcome.code}: ${outcome.stderr.trim() || "no reason on stderr"}`;
    throw new Refusal(
      `${why}; no receipt written; diagnostic ${diagnosticLine(diagnostic)}; output saved to ${ctx.logPath}; ${path}`,
    );
  }

  const verdict: "CLEAR" | "BLOCK" = result.verdict === "BLOCK" ? "BLOCK" : "CLEAR";
  const summary = successSummary(results);
  const saved = await saveFinalReceipt({
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
    },
  });
  if (saved.where === "sidecar") {
    if (saved.kept === "CLEAR" || saved.kept === "BLOCK") return saved.kept;
    throw new Refusal(
      `review of lane ${ctx.key} at ${ctx.tip} was preempted by a newer writer; the canonical receipt is ${saved.kept}; this job's ${verdict} is in ${progressPath(ctx.d.store.root, ctx.key, ctx.tip)}`,
    );
  }
  return verdict;
}
