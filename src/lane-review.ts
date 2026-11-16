import { appendFileSync, writeFileSync } from "node:fs";
import { prompt, type Deps } from "./harness.ts";
import { loadReviewSettings, substitute } from "./hooks.ts";
import { asSha, gitOut, laneGit, laneHead, laneRepo } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import { planReview } from "./review-chunks.ts";
import { diagnosticLine, type ReviewDiagnostic, reviewDiagnostic, writeReviewDiagnostic } from "./review-diagnostic.ts";
import { failed, failureKind, failureSummary, type LaneResult, type LaneRun, successSummary } from "./review-report.ts";
import { reviewLogPath, reviewTimeoutFromEnv, reviewVerdict, type ReviewVerdict, runReviewer } from "./review-run.ts";
import { KEY_RE, type LaneVerdict } from "./store-types.ts";

export type LaneReview = { readonly verdict: ReviewVerdict; readonly base: string; readonly tip: string };
export type LaneReviewOptions = { readonly timeoutMs?: number; readonly progressMs?: number };

/**
 * Reviews one lane's own commits: the merge-base of its recorded start commit and the current tip, diffed at that tip.
 * Writes `receipts/lane_<key>@<tip>.json`. The reviewer runs under a deadline, its output streams to
 * `state/reviews/<key>.log`, a diff over the size caps is split by path, a failed attempt is retried once with
 * `reviewFallbackModel`, and a timeout or an empty answer becomes a non-CLEAR receipt (`reviewer_timeout` /
 * `reviewer_empty`) instead of a silent no-receipt. Every failure also writes a JSON diagnostic with argv, model, exit
 * code, duration and both output tails.
 */
export async function reviewLane(
  d: Deps,
  key: string,
  model?: string,
  opts: LaneReviewOptions = {},
): Promise<LaneReview> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.baseSha === undefined)
    throw new Refusal(
      `lane ${key} has no recorded base commit (it started before the review gate); dori review --lane covers lanes started by this version`,
    );
  const repo = laneRepo(lane);
  const tip = await laneHead(d, lane);
  if (tip === undefined)
    throw new Refusal(`cannot read HEAD in ${repo}: the lane's checkout is gone or not a git repository`);
  const base = asSha(await gitOut(d, repo, ["merge-base", lane.baseSha, tip]));
  if (base === undefined)
    throw new Refusal(`cannot find the merge-base of ${lane.baseSha.slice(0, 12)} and ${tip.slice(0, 12)} in ${repo}`);
  if (base === tip) throw new Refusal(`lane ${key} has no commits since ${base.slice(0, 12)}; nothing to review`);

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
  const timeoutMs = opts.timeoutMs ?? reviewTimeoutFromEnv();
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
  const chunks = plan?.chunked ? plan.chunks : undefined;
  const runs: LaneRun[] = [];
  if (chunks === undefined) {
    const text = prompt("review-lane.md", { key, base, tip, brief: lane.brief, diff: diffPath, repo });
    runs.push({ label: `review lane ${key} at ${tip}`, text });
  } else {
    for (const chunk of chunks) {
      const chunkPath = d.store.receipts.laneChunkDiffPath(key, tip, chunk.index);
      writeFileSync(chunkPath, chunk.text);
      const text = prompt("review-lane-chunk.md", {
        key,
        base,
        tip,
        brief: lane.brief,
        repo,
        chunk: String(chunk.index),
        chunks: String(chunks.length),
        chunkPaths: chunk.paths.join(", "),
        chunkDiff: chunkPath,
      });
      runs.push({ label: `review lane ${key} chunk ${chunk.index}/${chunks.length}`, text, chunk });
    }
  }

  appendFileSync(logPath, `review lane ${key} at ${tip} (base ${base})\n`);
  const reviewerField = (): string => {
    const retried = results.some((r) => r.retried !== undefined);
    return `${reviewerFor(model)}${retried && fallback !== undefined ? `; retried with --model ${fallback}` : ""}`;
  };
  const results: LaneResult[] = [];
  const diagnose = (r: LaneResult): { diagnostic: ReviewDiagnostic; path: string } => {
    const diagnostic = reviewDiagnostic(
      r.argv,
      r.outcome,
      hook === undefined ? (r.model ?? null) : null,
      r.run.chunk === undefined || chunks === undefined ? undefined : `${r.run.chunk.index}/${chunks.length}`,
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
      reviewer: reviewerField(),
      at: d.now(),
      summary,
    });
    throw new Refusal(
      `${why}; receipt lane_${key}@${tip} says ${verdict}; diagnostic ${diagnosticLine(diagnostic)}; output saved to ${logPath}; ${diagPath}`,
    );
  };
  const attempt = async (run: LaneRun, m: string | undefined): Promise<LaneResult> => {
    const argv = argsFor(run.text, m);
    const outcome = await runReviewer({
      exec: d.exec,
      cmd: argv[0] ?? d.agentCmd,
      argv: argv.slice(1),
      log: logPath,
      label: run.label,
      timeoutMs,
      ...(opts.progressMs === undefined ? {} : { progressMs: opts.progressMs }),
    });
    const verdict = outcome.kind === "exit" ? reviewVerdict(outcome.stdout) : undefined;
    return {
      run,
      argv,
      outcome,
      ...(verdict === undefined ? {} : { verdict }),
      ...(m === undefined ? {} : { model: m }),
    };
  };

  for (const run of runs) {
    let result = await attempt(run, model);
    if (failed(result) && fallback !== undefined && fallback !== model) {
      const primary = result;
      const primaryDiag = diagnose(primary);
      result = await attempt(run, fallback);
      result.retried = `${primary.model ?? "default"} ${failureKind(primary)}`;
      result.retryDiagnostic = primaryDiag.path;
    }
    results.push(result);
    if (!failed(result)) continue;
    const outcome = result.outcome;
    const { diagnostic, path: diagPath } = diagnose(result);
    const summary = failureSummary(chunks, results, diagPath);
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

  const verdict: ReviewVerdict = results.some((r) => r.verdict === "BLOCK") ? "BLOCK" : "CLEAR";
  const summary = successSummary(chunks, results);
  d.store.saveLaneReceipt({
    lane: key,
    verdict,
    base,
    tip,
    brief: lane.brief,
    reviewer: reviewerField(),
    at: d.now(),
    summary,
  });
  lane.tipSha = tip;
  d.store.saveLane(lane);
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, base, tip };
}
