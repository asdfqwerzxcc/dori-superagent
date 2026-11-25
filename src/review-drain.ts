// The duty half of background reviews: report the last progress row, notice a worker that died without a receipt,
// close a finished review's session, and tell the lead once when a review passes two hours. It never kills a review.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { HOSTNAME } from "./process-identity.ts";
import {
  activeJobs,
  announceRun,
  duration,
  progressOf,
  readRunJob,
  REVIEW_SLOW_MS,
  runFiles,
  runPath,
  runsDir,
  type ReviewRunJob,
  workerAlive,
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

export type DrainRunsOptions = { readonly longMs?: number | undefined };

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

/** Closes the review's tab once the job is terminal, so a finished review leaves no idle shell behind. */
async function closeJobSession(d: Deps, job: ReviewRunJob): Promise<void> {
  if (job.session === undefined || job.sessionClosedAt !== undefined) return;
  if (job.host !== undefined && job.host !== HOSTNAME) return;
  const ref = parseRef(job.session);
  if (ref === undefined) return;
  try {
    await d.runtimes.for(ref).close(ref);
  } catch {
    // Already gone, or the runtime is down: the marker below keeps the next pass from retrying forever.
  }
  const current = readRunJob(runPath(d.store.root, job.job));
  if (current !== undefined) writeRunJob(d.store.root, { ...current, sessionClosedAt: d.now() });
}

/**
 * Reports the last progress row, notices a worker that died without a receipt, closes a finished review's session,
 * and tells the lead once when a review has run past `longMs`. A live review is never killed or shortened.
 */
export async function drainReviewRuns(d: Deps, opts: DrainRunsOptions = {}): Promise<ReviewRunEvent[]> {
  const events: ReviewRunEvent[] = [];
  dropInvalidRuns(d.store.root, events);
  const longMs = opts.longMs ?? REVIEW_SLOW_MS;
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
    if (job.state === "running" && job.workerPid !== undefined && !workerAlive(job)) {
      const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
      if (latest.state === "done" || latest.state === "failed") continue;
      const failed: ReviewRunJob = {
        ...latest,
        state: "failed",
        error: `the review worker (pid ${job.workerPid}) exited without writing a receipt`,
        finishedAt: d.now(),
      };
      writeRunJob(d.store.root, failed);
      if (await announceRun(d, failed))
        events.push({ pr: failed.pr, action: "review-failed", detail: failed.error ?? "worker exited" });
      await closeJobSession(d, failed);
      continue;
    }
    const elapsed = Math.max(0, d.now() - job.startedAt);
    events.push({
      pr: job.pr,
      action: job.state === "starting" ? "review-starting" : "review-running",
      detail: `${duration(elapsed)}; ${progressOf(job)}`,
    });
    if (elapsed >= longMs && job.slowNotifiedAt === undefined) {
      const latest = readRunJob(runPath(d.store.root, job.job)) ?? job;
      if (latest.slowNotifiedAt !== undefined || latest.state === "done" || latest.state === "failed") continue;
      const text =
        `[REVIEW ${latest.pr}] still running after ${duration(elapsed)}; not interrupted (job ${latest.job}). ` +
        `${progressOf(latest)}; log ${latest.log}`;
      try {
        const sent = await tellLead(d, text, "review");
        if (sent !== undefined) {
          writeRunJob(d.store.root, { ...latest, slowNotifiedAt: d.now() });
          events.push({ pr: latest.pr, action: "review-slow", detail: "notified once; left running" });
        }
      } catch {
        // Retry the one notice on the next pass; the review keeps running either way.
      }
    }
  }
  return events;
}

/** One line per active review for `dori status`: what is running, how long, and where its output stopped. */
export function reviewRunLines(d: Deps): string[] {
  return activeJobs(d.store.root).map((job) => {
    const elapsed = duration(Math.max(0, d.now() - job.startedAt));
    return `REVIEW ${job.pr} ${job.state} ${elapsed} last=${JSON.stringify(job.lastLine ?? "no output yet")} job=${job.job}`;
  });
}
