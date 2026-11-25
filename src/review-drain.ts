// The duty half of background reviews: report the last progress row, notice a worker that died without a receipt,
// close a finished review's session, and tell the lead once when a review passes two hours. It never kills a review.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { HOSTNAME } from "./process-identity.ts";
import { announceRun, claimMarker, pruneRuns, readSessionRef, releaseMarker } from "./review-meta.ts";
import {
  activeJobs,
  duration,
  firstLine,
  progressOf,
  readRunJob,
  REVIEW_CLOSE_ATTEMPTS,
  REVIEW_LAUNCH_MS,
  REVIEW_SLOW_MS,
  runFiles,
  runPath,
  runsDir,
  type ReviewRunJob,
  workerState,
  writeRunJob,
} from "./review-run.ts";
import { parseRef } from "./runtime/types.ts";

export type ReviewRunEvent = {
  readonly pr?: string;
  readonly action:
    | "review-starting"
    | "review-running"
    | "review-slow"
    | "review-done"
    | "review-failed"
    | "review-record-dropped";
  readonly detail?: string;
};

export type DrainRunsOptions = {
  readonly longMs?: number | undefined;
  readonly launchMs?: number | undefined;
  readonly readStartTime?: ((pid: number) => number | null) | undefined;
};

/** Drops records that cannot be read as jobs, so a corrupt row never wedges the review list. */
function dropInvalidRuns(root: string, events: ReviewRunEvent[]): void {
  let names: string[];
  try {
    names = readdirSync(runsDir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(runsDir(root), name);
    const job = readRunJob(path);
    if (job !== undefined && name === `${job.job}.json`) continue;
    rmSync(path, { force: true });
    events.push({ action: "review-record-dropped", detail: name });
  }
}

/** Closes the review's tab once the job is terminal, retrying a bounded number of times before giving up. */
async function closeJobSession(d: Deps, job: ReviewRunJob): Promise<void> {
  if (job.sessionClosedAt !== undefined) return;
  if (job.host !== undefined && job.host !== HOSTNAME) return;
  const session = job.session ?? readSessionRef(d.store.root, job.job);
  if (session === undefined) return;
  const ref = parseRef(session);
  if (ref === undefined) return;
  const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
  if (latest.sessionClosedAt !== undefined) return;
  const attempts = (latest.sessionCloseAttempts ?? 0) + 1;
  try {
    await d.runtimes.for(ref).close(ref);
    writeRunJob(d.store.root, { ...latest, sessionClosedAt: d.now(), sessionCloseAttempts: attempts });
  } catch (e) {
    const failed = { ...latest, sessionCloseAttempts: attempts, sessionCloseError: firstLine(e) };
    // A bounded retry: a dead runtime must not retry forever, and a transient one gets another pass.
    writeRunJob(d.store.root, attempts >= REVIEW_CLOSE_ATTEMPTS ? { ...failed, sessionClosedAt: d.now() } : failed);
  }
}

/**
 * Reports the last progress row, notices a worker that died without a receipt, closes a finished review's session,
 * and tells the lead once when a review has run past `longMs`. A live review is never killed or shortened; a launching
 * job that never writes its running row fails after the bounded `launchMs` window.
 */
export async function drainReviewRuns(d: Deps, opts: DrainRunsOptions = {}): Promise<ReviewRunEvent[]> {
  const events: ReviewRunEvent[] = [];
  dropInvalidRuns(d.store.root, events);
  const longMs = opts.longMs ?? REVIEW_SLOW_MS;
  const launchMs = opts.launchMs ?? REVIEW_LAUNCH_MS;
  for (const { job } of runFiles(d.store.root)) {
    if (job.state === "done" || job.state === "failed") {
      if (await announceRun(d, job))
        events.push({
          pr: job.pr,
          action: job.state === "done" ? "review-done" : "review-failed",
          detail:
            job.state === "done"
              ? `${job.verdict ?? "?"} receipt at ${job.sha?.slice(0, 12) ?? "?"}`
              : (job.error ?? "no reason given"),
        });
      await closeJobSession(d, job);
      continue;
    }
    const elapsed = Math.max(0, d.now() - job.startedAt);
    const launching = job.workerPid === undefined && (job.state === "starting" || job.state === "running");
    if (launching && elapsed >= launchMs) {
      const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
      if (latest.workerPid === undefined && (latest.state === "starting" || latest.state === "running")) {
        const receipt = latest.sha === undefined ? undefined : d.store.receipt(latest.pr, latest.sha);
        if (receipt !== undefined) {
          const done: ReviewRunJob = {
            ...latest,
            state: "done",
            verdict: receipt.verdict,
            sha: receipt.sha,
            finishedAt: d.now(),
          };
          writeRunJob(d.store.root, done);
          if (await announceRun(d, done))
            events.push({
              pr: done.pr,
              action: "review-done",
              detail: `${receipt.verdict} receipt at ${receipt.sha.slice(0, 12)}`,
            });
          await closeJobSession(d, done);
          continue;
        }
        const failed: ReviewRunJob = {
          ...latest,
          state: "failed",
          error: `the review worker did not write its running row within ${Math.round(launchMs / 1000)}s`,
          finishedAt: d.now(),
        };
        writeRunJob(d.store.root, failed);
        if (await announceRun(d, failed))
          events.push({ pr: failed.pr, action: "review-failed", detail: failed.error ?? "launch failed" });
        await closeJobSession(d, failed);
        continue;
      }
    }
    const state = job.state === "running" ? workerState(job, opts.readStartTime) : "unknown";
    if (state === "dead") {
      const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
      if (latest.state !== "running") continue;
      const receipt = latest.sha === undefined ? undefined : d.store.receipt(latest.pr, latest.sha);
      if (receipt !== undefined) {
        const done: ReviewRunJob = {
          ...latest,
          state: "done",
          verdict: receipt.verdict,
          sha: receipt.sha,
          finishedAt: d.now(),
        };
        writeRunJob(d.store.root, done);
        if (await announceRun(d, done))
          events.push({
            pr: done.pr,
            action: "review-done",
            detail: `${receipt.verdict} receipt at ${receipt.sha.slice(0, 12)}`,
          });
        await closeJobSession(d, done);
        continue;
      }
      const failed: ReviewRunJob = {
        ...latest,
        state: "failed",
        error: `the review worker (pid ${latest.workerPid}) exited without writing a receipt`,
        finishedAt: d.now(),
      };
      writeRunJob(d.store.root, failed);
      if (await announceRun(d, failed))
        events.push({ pr: failed.pr, action: "review-failed", detail: failed.error ?? "worker exited" });
      await closeJobSession(d, failed);
      continue;
    }
    events.push({
      pr: job.pr,
      action: launching ? "review-starting" : "review-running",
      detail: `${duration(elapsed)}; ${progressOf(job)}`,
    });
    if (!launching && elapsed >= longMs && job.slowNotifiedAt === undefined) {
      const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
      if (latest.slowNotifiedAt !== undefined || latest.state === "done" || latest.state === "failed") continue;
      if (!claimMarker(d.store.root, job.job, "slow")) continue;
      const text =
        `[REVIEW ${latest.pr}] still running after ${duration(elapsed)}; not interrupted (job ${latest.job}). ` +
        `${progressOf(latest)}; log ${latest.log}`;
      try {
        const sent = await tellLead(d, text, "review");
        if (sent === undefined) {
          releaseMarker(d.store.root, job.job, "slow");
          continue;
        }
        writeRunJob(d.store.root, { ...latest, slowNotifiedAt: d.now() });
        events.push({ pr: latest.pr, action: "review-slow", detail: "notified once; left running" });
      } catch {
        // Retry the one notice on the next pass; the review keeps running either way.
        releaseMarker(d.store.root, job.job, "slow");
      }
    }
  }
  pruneRuns(d.store.root, d.now());
  return events;
}

/** One line per active review for `dori status`: what is running, how long, and where its output stopped. */
export function reviewRunLines(d: Deps): string[] {
  return activeJobs(d.store.root).map((job) => {
    const elapsed = duration(Math.max(0, d.now() - job.startedAt));
    return `REVIEW ${job.pr} ${job.state} ${elapsed} last=${JSON.stringify(job.lastLine ?? "no output yet")} job=${job.job}`;
  });
}
