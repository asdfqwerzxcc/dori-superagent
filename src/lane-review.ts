import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prompt, type Deps } from "./harness.ts";
import { loadHooks, substitute } from "./hooks.ts";
import { asSha, gitOut, laneGit, laneHead, laneRepo } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import { type DiffChunk, planReview } from "./review-chunks.ts";
import {
  reviewLogPath,
  reviewTimeoutFromEnv,
  reviewVerdict,
  type ReviewOutcome,
  type ReviewVerdict,
  runReviewer,
} from "./review-run.ts";
import { KEY_RE, type LaneVerdict } from "./store-types.ts";

export type LaneReview = { readonly verdict: ReviewVerdict; readonly base: string; readonly tip: string };
export type LaneReviewOptions = { readonly timeoutMs?: number; readonly progressMs?: number };

type LaneRun = { readonly label: string; readonly argv: readonly string[] };
type LaneResult = { readonly run: LaneRun; readonly outcome: ReviewOutcome; readonly verdict?: ReviewVerdict };

const tail = (text: string): string => (text.trim() === "" ? "(empty)" : text.trim().slice(-1200));

const exitLine = (outcome: ReviewOutcome): string =>
  outcome.kind === "timeout"
    ? `timed out${outcome.code === undefined ? " (killed)" : ` (killed, exit ${outcome.code})`}`
    : `exit ${outcome.code}`;

const detail = (r: LaneResult): string =>
  `${r.run.label}: ${exitLine(r.outcome)}\nstderr:\n${tail(r.outcome.stderr)}\nstdout:\n${tail(r.outcome.stdout)}`;

/** One line that names every planned chunk and what happened to it, so the receipt covers the whole diff. */
const digest = (chunks: readonly DiffChunk[], results: readonly LaneResult[]): string =>
  `chunks: ${chunks
    .map((c, i) => {
      const r = results[i];
      const state =
        r === undefined ? "not run" : (r.verdict ?? (r.outcome.kind === "timeout" ? "timed out" : "no output"));
      return `${c.index}/${chunks.length} [${c.paths.join(", ")}] ${c.bytes} B/${c.lines} changed -> ${state}`;
    })
    .join("; ")}`;

const failureSummary = (chunks: readonly DiffChunk[] | undefined, results: readonly LaneResult[]): string =>
  [...(chunks === undefined ? [] : [digest(chunks, results)]), ...results.map((r) => `--- ${detail(r)}`)]
    .join("\n")
    .slice(0, 4000);

/**
 * Reviews one lane's own commits: the merge-base of its recorded start commit and the current tip, diffed at that tip.
 * Writes `receipts/lane_<key>@<tip>.json`. The reviewer runs under a deadline, its output streams to
 * `state/reviews/<key>.log`, a diff over the size caps is split by path, and a timeout or an empty answer becomes a
 * non-CLEAR receipt (`reviewer_timeout` / `reviewer_empty`) instead of a silent no-receipt.
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
  const deadlineAt = Date.now() + (opts.timeoutMs ?? reviewTimeoutFromEnv());
  const hook = loadHooks(d.store.root).reviewCommand;
  const vars = { lane: key, key, base, tip, sha: tip, brief: lane.brief, diff: diffPath, repo };
  const reviewerName = hook
    ? `hook: ${hook.join(" ")}`
    : `${d.agentCmd} -p --no-session${model ? ` --model ${model}` : ""}`;
  const argsFor = (text: string): readonly string[] => {
    const argv = hook
      ? substitute(hook, vars)
      : [d.agentCmd, "-p", "--no-session", ...(model ? ["--model", model] : []), text];
    return [argv[0] ?? d.agentCmd, ...argv.slice(1)];
  };

  const plan = hook ? undefined : planReview(diff.stdout);
  const chunks = plan?.chunked ? plan.chunks : undefined;
  const runs: LaneRun[] = [];
  if (chunks === undefined) {
    const text = prompt("review-lane.md", { key, base, tip, brief: lane.brief, diff: diffPath, repo });
    runs.push({ label: `review lane ${key} at ${tip}`, argv: argsFor(text) });
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
      runs.push({ label: `review lane ${key} chunk ${chunk.index}/${chunks.length}`, argv: argsFor(text) });
    }
  }

  appendFileSync(logPath, `review lane ${key} at ${tip} (base ${base})\n`);
  const fail = (
    verdict: Extract<LaneVerdict, "reviewer_timeout" | "reviewer_empty">,
    summary: string,
    why: string,
  ): never => {
    d.store.saveLaneReceipt({
      lane: key,
      verdict,
      base,
      tip,
      brief: lane.brief,
      reviewer: reviewerName,
      at: d.now(),
      summary,
    });
    throw new Refusal(`${why}; receipt lane_${key}@${tip} says ${verdict}; output saved to ${logPath}`);
  };

  const results: LaneResult[] = [];
  for (const run of runs) {
    const outcome = await runReviewer({
      exec: d.exec,
      cmd: run.argv[0] ?? d.agentCmd,
      argv: run.argv.slice(1),
      log: logPath,
      label: run.label,
      timeoutMs: deadlineAt - Date.now(),
      ...(opts.progressMs === undefined ? {} : { progressMs: opts.progressMs }),
    });
    const verdict = outcome.kind === "exit" ? reviewVerdict(outcome.stdout) : undefined;
    results.push({ run, outcome, ...(verdict === undefined ? {} : { verdict }) });
    if (outcome.kind === "timeout")
      fail("reviewer_timeout", failureSummary(chunks, results), `reviewer for lane ${key} timed out`);
    if (outcome.kind === "exit" && outcome.stdout.trim() === "")
      fail(
        "reviewer_empty",
        failureSummary(chunks, results),
        `reviewer for lane ${key} printed no output (exit ${outcome.code})`,
      );
    if (outcome.kind === "exit" && verdict === undefined) {
      const diagnostic = join(d.store.root, "receipts", `lane_${key}@${tip}-${randomUUID()}.noverdict.txt`);
      const stdout = outcome.stdout.split(/\r?\n/).slice(-200).join("\n");
      writeFileSync(
        diagnostic,
        `${run.label}: exit ${outcome.code}\nstderr:\n${tail(outcome.stderr)}\nstdout:\n${stdout}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      const reason =
        outcome.code === 0
          ? "reviewer printed no VERDICT line"
          : `reviewer exited ${outcome.code}: ${outcome.stderr.trim() || "no VERDICT line in its output"}`;
      throw new Refusal(`${reason}; no receipt written; reviewer output saved to ${diagnostic}`);
    }
    if (outcome.kind === "exit" && outcome.code !== 0)
      throw new Refusal(
        `reviewer exited ${outcome.code}: ${outcome.stderr.trim() || "no reason on stderr"}; no receipt written; output saved to ${logPath}`,
      );
  }

  const verdict: ReviewVerdict = results.some((r) => r.verdict === "BLOCK") ? "BLOCK" : "CLEAR";
  const summary =
    chunks === undefined
      ? (results.at(-1)?.outcome.stdout.trim() ?? "").slice(-4000)
      : `${digest(chunks, results)}\n${results.map((r) => `--- ${r.run.label}\n${r.outcome.stdout.trim()}`).join("\n")}`.slice(
          0,
          4000,
        );
  d.store.saveLaneReceipt({
    lane: key,
    verdict,
    base,
    tip,
    brief: lane.brief,
    reviewer: reviewerName,
    at: d.now(),
    summary,
  });
  lane.tipSha = tip;
  d.store.saveLane(lane);
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, base, tip };
}
