import { appendFileSync, writeFileSync } from "node:fs";
import { prompt, type Deps } from "./harness.ts";
import { loadReviewSettings, substitute } from "./hooks.ts";
import { reviewChunks } from "./lane-review-chunks.ts";
import { laneReviewTarget } from "./lane-review-target.ts";
import { laneGit } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import { type DiffChunk, planReview } from "./review-chunks.ts";
import { diagnosticLine, type ReviewDiagnostic, reviewDiagnostic, writeReviewDiagnostic } from "./review-diagnostic.ts";
import { failed, failureKind, failureSummary, type LaneResult, type LaneRun, successSummary } from "./review-report.ts";
import {
  REVIEW_ATTEMPT_MS,
  reviewBudgetFromEnv,
  reviewLogPath,
  reviewTimeoutFromEnv,
  reviewVerdict,
  type ReviewVerdict,
  runReviewer,
} from "./review-run.ts";
import type { LaneVerdict } from "./store-types.ts";

export type LaneReview = { readonly verdict: ReviewVerdict; readonly base: string; readonly tip: string };
export type LaneReviewOptions = {
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
  readonly progressMs?: number;
  readonly verdictGraceMs?: number;
};

/** Reviews one lane's commits into `receipts/lane_<key>@<tip>.json`; a large diff is split into `reviewChunks`. */
export async function reviewLane(
  d: Deps,
  key: string,
  model?: string,
  opts: LaneReviewOptions = {},
): Promise<LaneReview> {
  const { lane, repo, tip, base } = await laneReviewTarget(d, key);

  const diff = await laneGit(d, repo, ["--no-pager", "diff", "--no-color", "--no-ext-diff", `${base}..${tip}`]);
  if (diff.code !== 0)
    throw new Refusal(
      `git diff ${base.slice(0, 12)}..${tip.slice(0, 12)} failed: ${(diff.stderr || diff.stdout).trim()}`,
    );
  const diffPath = d.store.laneDiffPath(key, tip);
  writeFileSync(diffPath, diff.stdout);

  const logPath = reviewLogPath(d.store.root, key);
  const settings = loadReviewSettings(d.store.root);
  const hook = settings.hooks.reviewCommand;
  const fallback = hook === undefined ? settings.fallbackModel : undefined;
  // A configured `reviewModel` is the default reviewer, so a lane never has to spell --model and never falls onto an
  // agent default that the provider may refuse.
  const chosen = model ?? settings.model;
  const timeoutMs = opts.timeoutMs ?? reviewTimeoutFromEnv();
  const budgetMs = opts.budgetMs ?? reviewBudgetFromEnv();
  // Each attempt is soft-capped at half the chunk window, so a stalled primary cannot eat the fallback's turn.
  const attemptMs = Math.max(1, Math.min(REVIEW_ATTEMPT_MS, Math.floor(timeoutMs / 2)));
  const deadline = Date.now() + budgetMs;
  const budgetLeft = (): number => deadline - Date.now();
  const vars = { lane: key, key, base, tip, sha: tip, brief: lane.brief, diff: diffPath, repo };
  const argsFor = (text: string, m: string | undefined): readonly string[] => {
    const argv = hook
      ? substitute(hook, vars)
      : [d.agentCmd, "-p", "--no-session", ...(m === undefined ? [] : ["--model", m]), text];
    return [argv[0] ?? d.agentCmd, ...argv.slice(1)];
  };
  const reviewerFor = (m: string | undefined): string =>
    hook === undefined
      ? `${d.agentCmd} -p --no-session${m === undefined ? "" : ` --model ${m}`}`
      : `hook: ${hook.join(" ")}`;

  const plan = hook === undefined ? planReview(diff.stdout) : undefined;
  const chunked = plan?.chunked === true;
  const chunks = chunked ? plan!.chunks : undefined;
  let chunkSlot = 0;
  const chunkRun = (
    chunk: DiffChunk,
    total: number,
    resplit = false,
    parent?: { readonly index: number; readonly total: number },
  ): LaneRun => {
    const chunkPath = d.store.receipts.laneChunkDiffPath(key, tip, ++chunkSlot);
    writeFileSync(chunkPath, chunk.text);
    const text = prompt("review-lane-chunk.md", {
      key,
      base,
      tip,
      brief: lane.brief,
      repo,
      chunk: String(chunk.index),
      chunks: String(total),
      chunkPaths: chunk.label ?? chunk.paths.join(", "),
      chunkDiff: chunkPath,
    });
    return {
      label: `review lane ${key} chunk ${chunk.index}/${total}`,
      text,
      chunk,
      chunkTotal: total,
      ...(resplit ? { resplit: true as const } : {}),
      ...(parent === undefined ? {} : { parent }),
    };
  };
  const runs: LaneRun[] = [];
  if (chunks === undefined) {
    const text = prompt("review-lane.md", { key, base, tip, brief: lane.brief, diff: diffPath, repo });
    runs.push({ label: `review lane ${key} at ${tip}`, text });
  } else {
    for (const chunk of chunks) runs.push(chunkRun(chunk, chunks.length));
  }

  appendFileSync(logPath, `review lane ${key} at ${tip} (base ${base})\n`);
  const results: LaneResult[] = [];
  const reviewerField = (rs: readonly LaneResult[]): string => {
    const retried = rs.some((r) => r.retried !== undefined);
    return `${reviewerFor(chosen)}${retried && fallback !== undefined ? `; retried with --model ${fallback}` : ""}`;
  };
  const diagnose = (r: LaneResult): { diagnostic: ReviewDiagnostic; path: string } => {
    const diagnostic = reviewDiagnostic(
      r.argv,
      r.outcome,
      hook === undefined ? (r.model ?? null) : null,
      r.run.chunk === undefined || r.run.chunkTotal === undefined
        ? undefined
        : `${r.run.parent?.index ?? r.run.chunk.index}/${r.run.parent?.total ?? r.run.chunkTotal}`,
    );
    return { diagnostic, path: writeReviewDiagnostic(d.store.root, key, tip, diagnostic) };
  };
  const fail = (
    verdict: Extract<LaneVerdict, "reviewer_timeout" | "reviewer_empty">,
    summary: string,
    why: string,
    diagnostic: ReviewDiagnostic,
    diagPath: string,
  ): never => {
    d.store.saveLaneReceipt({
      lane: key,
      verdict,
      base,
      tip,
      brief: lane.brief,
      reviewer: reviewerField(results),
      at: d.now(),
      summary,
    });
    throw new Refusal(
      `${why}; receipt lane_${key}@${tip} says ${verdict}; diagnostic ${diagnosticLine(diagnostic)}; output saved to ${logPath}; ${diagPath}`,
    );
  };
  const attempt = async (run: LaneRun, m: string | undefined, limitMs: number): Promise<LaneResult> => {
    const argv = argsFor(run.text, m);
    const outcome = await runReviewer({
      exec: d.exec,
      cmd: argv[0] ?? d.agentCmd,
      argv: argv.slice(1),
      log: logPath,
      label: run.label,
      timeoutMs: Math.max(1, limitMs),
      ...(opts.progressMs === undefined ? {} : { progressMs: opts.progressMs }),
      ...(opts.verdictGraceMs === undefined ? {} : { verdictGraceMs: opts.verdictGraceMs }),
    });
    const verdict = outcome.kind === "error" ? undefined : reviewVerdict(outcome.stdout);
    return {
      run,
      argv,
      outcome,
      ...(verdict === undefined ? {} : { verdict }),
      ...(m === undefined ? {} : { model: m }),
    };
  };

  if (chunked) {
    const verdict = await reviewChunks({
      d,
      key,
      brief: lane.brief,
      base,
      tip,
      logPath,
      chosen,
      timeoutMs,
      attemptMs,
      budgetMs,
      fallback,
      reviewer: reviewerFor(chosen),
      runs,
      chunkRun,
      attempt,
      diagnose,
      reviewerField,
    });
    lane.tipSha = tip;
    d.store.saveLane(lane);
    d.usage.record({ name: "dori.review_completed", verdict });
    return { verdict, base, tip };
  }

  const run = runs[0]!;
  let result = await attempt(run, chosen, Math.min(timeoutMs, Math.max(1, budgetLeft())));
  if (failed(result) && fallback !== undefined && fallback !== chosen && budgetLeft() > 0) {
    const primary = result;
    const primaryDiag = diagnose(primary);
    result = await attempt(run, fallback, Math.min(timeoutMs, Math.max(1, budgetLeft())));
    result.retried = `${primary.model ?? "default"} ${failureKind(primary)}`;
    result.retryDiagnostic = primaryDiag.path;
  }
  results.push(result);
  if (failed(result)) {
    const { diagnostic, path: diagPath } = diagnose(result);
    const summary = failureSummary(results, diagPath);
    const outcome = result.outcome;
    if (outcome.kind === "error")
      throw new Refusal(
        `reviewer for lane ${key} threw: ${outcome.message}; no receipt written; diagnostic ${diagnosticLine(diagnostic)}; output saved to ${logPath}; ${diagPath}`,
      );
    if (outcome.kind === "timeout")
      fail("reviewer_timeout", summary, `reviewer for lane ${key} timed out`, diagnostic, diagPath);
    if (outcome.stdout.trim() === "")
      fail(
        "reviewer_empty",
        summary,
        `reviewer for lane ${key} printed no output (exit ${outcome.code})`,
        diagnostic,
        diagPath,
      );
    const why =
      outcome.code === 0
        ? "reviewer printed no VERDICT line"
        : `reviewer exited ${outcome.code}: ${outcome.stderr.trim() || "no reason on stderr"}`;
    throw new Refusal(
      `${why}; no receipt written; diagnostic ${diagnosticLine(diagnostic)}; output saved to ${logPath}; ${diagPath}`,
    );
  }
  const verdict: ReviewVerdict = result.verdict === "BLOCK" ? "BLOCK" : "CLEAR";
  const summary = successSummary(results);
  d.store.saveLaneReceipt({
    lane: key,
    verdict,
    base,
    tip,
    brief: lane.brief,
    reviewer: reviewerField(results),
    at: d.now(),
    summary,
  });
  lane.tipSha = tip;
  d.store.saveLane(lane);
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, base, tip };
}
