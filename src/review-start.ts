// The start half of a background review: open a tab in the lead's workspace, launch the worker there, and return.
// No clock decides whether a start may happen; free memory does.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shq } from "./delivery.ts";
import { isPrId } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import {
  firstLine,
  JOB_RE,
  readRunJob,
  reviewCapacity,
  REVIEW_MEM_MB,
  reviewLogPath,
  reviewRunId,
  runPath,
  type ReviewRunJob,
  activeJobs,
  writeRunJob,
} from "./review-run.ts";
import { formatRef, openSession } from "./runtime/types.ts";

const CLI = join(import.meta.dir, "cli.ts");

/** Opens the review's own session; the command starts the worker there, so it outlives the lead's CLI process. */
async function openReviewSession(d: Deps, job: ReviewRunJob): Promise<string> {
  const rt = d.runtimes.default;
  const self = d.runtimes.selfAny(process.env);
  // Stay in the lead's workspace so a review is a tab, never a new window: the lane rule on Windows depends on it.
  const lead = d.store.roles().lead;
  const group = self?.runtime === rt.kind ? self.group : lead?.runtime === rt.kind ? lead.group : undefined;
  const command = `${shq(process.execPath)} ${shq(CLI)} review ${shq(job.pr)} --job ${shq(job.job)}`;
  const ref = await openSession(
    rt,
    {
      name: `review-${job.job}`,
      role: "review",
      container: "tab",
      cwd: d.store.root,
      env: { DORI_HOME: d.store.root },
      ...(group === undefined ? {} : { group }),
    },
    command,
  );
  return formatRef(ref);
}

export type StartReviewOptions = { readonly model?: string | undefined; readonly job?: string | undefined };

/**
 * Starts one background review for a PR and returns at once. A live review of the same PR is returned instead of a
 * duplicate. Admission reads free memory only: enough for one reviewer, or the start is refused with the numbers.
 */
export async function startBackgroundReview(
  d: Deps,
  pr: string,
  opts: StartReviewOptions = {},
): Promise<{ job: ReviewRunJob; existing: boolean }> {
  if (!isPrId(pr)) throw new Refusal(`PR must look like owner/repo#123, got ${pr}`);
  const active = activeJobs(d.store.root);
  const same = active.find((job) => job.pr === pr);
  if (same !== undefined) {
    // A start that never reached its session opened no worker: it is not a live review, so a retry may replace it.
    if (same.state !== "starting" || same.session !== undefined) return { job: same, existing: true };
    writeRunJob(d.store.root, {
      ...same,
      state: "failed",
      error: "the start ended before it opened a review session",
      finishedAt: d.now(),
      announcedAt: d.now(),
    });
  }
  const live = active.filter((job) => !(job.state === "starting" && job.session === undefined));
  const host = d.host();
  const slots = reviewCapacity(host);
  if (live.length >= slots)
    throw new Refusal(
      `cannot start a review for ${pr}: ${live.length} already running and free memory ${host.memFreePct}% ` +
        `(${host.memFreeMb} MB) holds ${slots} reviewer(s) at about ${REVIEW_MEM_MB} MB each; wait for one to finish`,
    );
  const job = opts.job ?? reviewRunId(pr);
  if (!JOB_RE.test(job)) throw new Refusal(`invalid review job id ${job}`);
  const record: ReviewRunJob = {
    job,
    pr,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    state: "starting",
    startedAt: d.now(),
    log: reviewLogPath(d.store.root, job),
  };
  mkdirSync(dirname(record.log), { recursive: true });
  writeRunJob(d.store.root, record);
  try {
    const session = await openReviewSession(d, record);
    // The worker may already have written its pid and session; merge, never overwrite.
    const after = readRunJob(runPath(d.store.root, job)) ?? record;
    const started: ReviewRunJob = { ...after, session };
    writeRunJob(d.store.root, started);
    return { job: started, existing: false };
  } catch (e) {
    const why = firstLine(e);
    // The caller sees this failure now; duty must not report it a second time.
    writeRunJob(d.store.root, {
      ...record,
      state: "failed",
      error: `could not open the review session: ${why}`,
      finishedAt: d.now(),
      announcedAt: d.now(),
    });
    throw new Refusal(`cannot start the review for ${pr}: ${why}`);
  }
}
