// The `dori review --lane` commands: record a request and print it, or record the reviewer's verdict as the lane
// receipt. Neither command spawns a reviewer; the lead runs the review from `dori review` in its own session and
// attests what it answered.

import { need, one, type Args } from "./cli-args.ts";
import { attest, isPrId } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { loadReviewSettings } from "./hooks.ts";
import { laneReviewTarget } from "./lane-review-target.ts";
import { Refusal } from "./refusal.ts";
import { reviewRunLines } from "./review-drain.ts";
import { finishJob, jobPath, killRecordedRun, legacyKillEnabled, readJob } from "./review-job.ts";
import { review } from "./review-pr.ts";
import { queueLaneReview, reviewJobId } from "./review-queue.ts";
import { readRunJob, runPath } from "./review-run.ts";
import { startBackgroundReview } from "./review-start.ts";
import { runReviewJob } from "./review-worker.ts";

export async function runReviewLane(
  d: Deps,
  lane: string,
  model: string | undefined,
  restart: boolean,
  legacyKill = false,
): Promise<number> {
  const outcome = await queueLaneReview(d, lane, model, { restart, legacyKill });
  const { job } = outcome;
  const id = reviewJobId(job.lane, job.tip);
  if (outcome.kind === "existing") console.log(`already queued ${id} (${outcome.state})`);
  else console.log(`QUEUED ${job.lane} ${job.tip} ${id}${outcome.kind === "restarted" ? " (restarted)" : ""}`);
  return 0;
}

/** `dori review`: a PR or lane attestation, a queued lane request, a background review, or the unchanged PR reviewer. */
export async function runReviewCommand(d: Deps, a: Args, x: string | undefined): Promise<number> {
  const lane = one(a, "lane");
  const legacyKill = a.flags.has("legacy-kill");
  const jobId = one(a, "job");
  if (jobId !== undefined) {
    if (a.flags.has("background")) throw new Refusal("give --job or --background, not both");
    if (lane !== undefined || a.flags.has("attest")) throw new Refusal("--job only runs a background review worker");
    if (x !== undefined) {
      const record = readRunJob(runPath(d.store.root, jobId));
      if (record !== undefined && record.pr !== x) throw new Refusal(`job ${jobId} reviews ${record.pr}, not ${x}`);
    }
    const job = await runReviewJob(d, jobId);
    console.log(
      `REVIEW ${job.pr} ${job.state}${job.verdict === undefined ? "" : ` verdict=${job.verdict}`}` +
        `${job.error === undefined ? "" : ` error=${job.error}`}`,
    );
    return job.state === "done" && job.verdict === "CLEAR" ? 0 : 1;
  }
  if (a.flags.has("list")) {
    const lines = reviewRunLines(d);
    for (const line of lines) console.log(line);
    if (lines.length === 0) console.log("REVIEWS none");
    return 0;
  }
  if (a.flags.has("attest")) {
    if (lane !== undefined && x !== undefined) throw new Refusal("give a PR or --lane, not both");
    const target = lane ?? need(x, "PR or lane key");
    const verdict = one(a, "verdict");
    if (verdict !== "CLEAR" && verdict !== "BLOCK") throw new Refusal("--attest needs --verdict CLEAR|BLOCK");
    const summary = one(a, "summary");
    const reviewer = need(one(a, "reviewer"), "--reviewer");
    const evidence = a.flags.get("evidence") ?? [];
    if (isPrId(target)) {
      const r = await attest(d, target, {
        verdict,
        reviewer,
        ...(summary === undefined ? {} : { summary }),
        evidence,
      });
      console.log(`ATTESTED ${target} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    const r = await attestLane(d, target, {
      verdict,
      reviewer,
      ...(summary === undefined ? {} : { summary }),
      evidence,
      ...(legacyKill ? { legacyKill } : {}),
    });
    console.log(`ATTESTED ${target} tip=${r.tip} verdict=${r.verdict}${r.kept ? " (kept)" : ""}`);
    return r.verdict === "CLEAR" ? 0 : 1;
  }
  if (a.flags.has("background")) {
    if (lane !== undefined) throw new Refusal("--background starts a PR review; give a PR, not --lane");
    const pr = need(x, "PR");
    if (!isPrId(pr)) throw new Refusal(`PR must look like owner/repo#123, got ${pr}`);
    const started = await startBackgroundReview(d, pr, {
      model: one(a, "model"),
      restart: a.flags.has("restart"),
    });
    const { job } = started;
    const where = job.session === undefined ? "" : ` session=${job.session}`;
    const state = started.existing ? "REVIEW_RUNNING" : started.restarted ? "REVIEW_RESTARTED" : "REVIEW_STARTED";
    console.log(`${state} ${job.pr} job=${job.job}${where} log=${job.log}`);
    return 0;
  }
  if (lane !== undefined) {
    if (x !== undefined) throw new Refusal("give a PR or --lane, not both");
    return runReviewLane(d, lane, one(a, "model"), a.flags.has("restart"), legacyKill);
  }
  const prId = need(x, "PR");
  const r = await review(d, prId, one(a, "model") ?? loadReviewSettings(d.store.root).model);
  console.log(`REVIEW ${prId} head=${r.sha} verdict=${r.verdict}`);
  return r.verdict === "CLEAR" ? 0 : 1;
}

export type LaneAttestOptions = {
  readonly verdict: "CLEAR" | "BLOCK";
  readonly reviewer: string;
  readonly summary?: string | undefined;
  readonly evidence: readonly string[];
  readonly legacyKill?: boolean;
};

export type LaneAttest = { readonly verdict: "CLEAR" | "BLOCK"; readonly tip: string; readonly kept: boolean };

/**
 * Records a reviewer session's verdict as the lane receipt at the lane's current tip. The schema is the same one the
 * gate has always read (`lane`, `verdict`, `base`, `tip`, `brief`, `reviewer`, `at`, `summary`), plus the evidence the
 * verdict rested on. BLOCK still wins at one tip: a CLEAR attest never replaces a BLOCK already on disk.
 */
export async function attestLane(d: Deps, key: string, opts: LaneAttestOptions): Promise<LaneAttest> {
  if (opts.evidence.length === 0)
    throw new Refusal("--attest needs at least one --evidence link (task id, path or url)");
  const { lane, tip, base } = await laneReviewTarget(d, key);
  const existing = d.store.laneReceipt(key, tip);
  const kept = existing?.verdict === "BLOCK" && opts.verdict === "CLEAR";
  const verdict = kept ? "BLOCK" : opts.verdict;
  if (!kept) {
    d.store.saveLaneReceipt({
      lane: lane.key,
      verdict,
      base,
      tip,
      brief: lane.brief,
      reviewer: opts.reviewer,
      at: d.now(),
      summary: [opts.summary ?? "", ...opts.evidence].filter(Boolean).join("\n"),
      evidence: [...opts.evidence],
    });
  }
  const current = d.store.lane(lane.key);
  if (current !== undefined) {
    current.tipSha = tip;
    d.store.saveLane(current);
  }
  const path = jobPath(d.store.root, lane.key, tip);
  const job = readJob(path);
  if (job !== undefined) {
    if (legacyKillEnabled(process.env, opts.legacyKill)) {
      const killed = killRecordedRun(d.store.root, lane.key, tip);
      if (killed.state === "failed")
        process.stderr.write(
          `dori: lane ${lane.key}: the legacy reviewer could not be killed (${killed.why}); the receipt was written\n`,
        );
    }
    finishJob(path, job.requestedAt);
  }
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, tip, kept };
}
