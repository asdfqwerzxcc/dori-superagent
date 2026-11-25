// The start half of a background review: open a tab in the lead's workspace, launch the worker there, and return.
// No clock decides whether a start may happen; free memory does. A session marker is written beside the job row, so
// the parent's post-start write cannot race the worker's first running write.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shq } from "./delivery.ts";
import { isPrId } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { readSessionRef, writeSessionRef } from "./review-meta.ts";
import {
  activeJobs,
  firstLine,
  JOB_RE,
  reviewCapacity,
  REVIEW_MEM_MB,
  reviewLogPath,
  reviewRunId,
  writeRunJob,
  type ReviewRunJob,
} from "./review-run.ts";
import { formatRef, openSession, parseRef } from "./runtime/types.ts";

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

/** Closes the tab of a start that never wrote its running row; no worker can be using it. */
async function closeStartSession(d: Deps, job: ReviewRunJob): Promise<void> {
  const session = job.session ?? readSessionRef(d.store.root, job.job);
  if (session === undefined) return;
  const ref = parseRef(session);
  if (ref === undefined) return;
  try {
    await d.runtimes.for(ref).close(ref);
  } catch {
    // Duty's bounded close retry owns the marker; the tab may already be gone.
  }
}

export type StartReviewOptions = {
  readonly model?: string | undefined;
  readonly job?: string | undefined;
  readonly restart?: boolean | undefined;
};

export type StartReviewResult = { readonly job: ReviewRunJob; readonly existing: boolean; readonly restarted: boolean };

/**
 * Starts one background review for a PR and returns at once. A live review of the same PR is returned instead of a
 * duplicate. A start that never opened a session is retried automatically; a stuck start that did open a tab needs
 * `--restart`. Admission reads free memory only: enough for one reviewer, or the start is refused with the numbers.
 */
export async function startBackgroundReview(
  d: Deps,
  pr: string,
  opts: StartReviewOptions = {},
): Promise<StartReviewResult> {
  if (!isPrId(pr)) throw new Refusal(`PR must look like owner/repo#123, got ${pr}`);
  let active = activeJobs(d.store.root);
  const same = active.find((job) => job.pr === pr);
  let restarted = false;
  if (same !== undefined) {
    const stuck = same.state === "starting" && same.workerPid === undefined;
    const session = same.session ?? readSessionRef(d.store.root, same.job);
    const replace = stuck && (session === undefined || opts.restart === true);
    if (!replace) {
      if (opts.restart === true)
        throw new Refusal(
          `a review for ${pr} is already running (job ${same.job}); --restart only replaces a start that never ` +
            `wrote its running row`,
        );
      return { job: { ...same, ...(session === undefined ? {} : { session }) }, existing: true, restarted: false };
    }
    const why =
      session === undefined
        ? "the start ended before it opened a review session"
        : "restarted before its worker wrote the running row";
    writeRunJob(d.store.root, {
      ...same,
      state: "failed",
      error: why,
      finishedAt: d.now(),
      announcedAt: d.now(),
    });
    await closeStartSession(d, same);
    active = active.filter((job) => job.job !== same.job);
    restarted = true;
  }
  const host = d.host();
  const slots = reviewCapacity(host);
  if (active.length >= slots)
    throw new Refusal(
      `cannot start a review for ${pr}: ${active.length} already running and free memory ${host.memFreePct}% ` +
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
  let session: string | undefined;
  try {
    session = await openReviewSession(d, record);
    // A separate atomic marker, not a second job-row write: the worker's first running write cannot be overwritten.
    writeSessionRef(d.store.root, job, session);
    return { job: { ...record, session }, existing: false, restarted };
  } catch (e) {
    const why = firstLine(e);
    if (session !== undefined) await closeStartSession(d, { ...record, session });
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
