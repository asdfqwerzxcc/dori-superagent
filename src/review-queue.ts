// The review queue: `dori review --lane` records what to review and returns, so the lead that asked is never held for
// the reviewer's deadline. The duty worker drains the records in its own pane and tells the lead the verdict.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { writeJson } from "./json-file.ts";
import { laneReviewTarget } from "./lane-review-target.ts";
import { reviewLane } from "./lane-review.ts";
import { Refusal } from "./refusal.ts";
import {
  clearRun,
  finishJob,
  jobPath,
  killRecordedRun,
  killRunFile,
  liveRun,
  queueDir,
  readJob,
  readRun,
  reviewFiles,
  reviewerIdentity,
  writeRun,
  type ReviewJob,
  type ReviewJobState,
} from "./review-job.ts";
import { type KillTree, killReviewTree } from "./review-kill.ts";
import { lockLive } from "./loop-lock.ts";

/** A drain result, shaped like a duty event so `dori duty` prints it with every other line. */
export type ReviewEvent = {
  readonly lane?: string;
  readonly action:
    | "review-done"
    | "review-failed"
    | "review-record-dropped"
    | "review-cancelled"
    | "review-kill-failed";
  readonly detail?: string;
};

/** What a `dori review --lane` call did: queued, deduped onto the job already there, restarted, or left for inline. */
export type QueueOutcome =
  | { readonly kind: "queued"; readonly job: ReviewJob }
  | { readonly kind: "restarted"; readonly job: ReviewJob }
  | { readonly kind: "existing"; readonly job: ReviewJob; readonly state: ReviewJobState }
  | { readonly kind: "inline" };

/** The job was replaced or cancelled while this drain owned it; the old run must stop without touching the new job. */
export class ReviewCancelled extends Error {
  constructor() {
    super("review job was replaced or cancelled");
  }
}

/** True while a duty loop runs in this home: its lock is held by a process that is alive on this host. */
const reviewWorker = (d: Deps): boolean => lockLive(d.store.lockPath("duty"));
const KILL_FAILED_KEPT = "the reviewer tree is still alive; the job is kept for the next pass";

/** The record a dead worker left must not run beside the inline review: kill its reviewer, then take the record out. */
function dropStaleJob(root: string, lane: string, tip: string): void {
  const prior = killRecordedRun(root, lane, tip);
  if (prior.state === "failed")
    throw new Refusal(
      `lane ${lane} at ${tip.slice(0, 12)}: the reviewer a dead worker left could not be killed (${prior.why}); ` +
        "the job was kept and no inline review was started",
    );
  const path = jobPath(root, lane, tip);
  const aside = `${path}.inline.${process.pid}`;
  try {
    renameSync(path, aside);
    rmSync(aside, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * The queue side of `dori review --lane`: with a duty loop running, records the job atomically and hands it back. A
 * request for the same lane+tip while one is in flight returns that record and never a second reviewer; only
 * `--restart` kills the reviewer already running and queues a fresh job. With no worker it drops a record a dead
 * worker left for this lane+tip (killing its reviewer tree) and returns `inline`, so the caller reviews it now.
 */
export async function queueLaneReview(
  d: Deps,
  key: string,
  model: string | undefined,
  opts: { readonly restart?: boolean } = {},
): Promise<QueueOutcome> {
  const { lane, tip, base } = await laneReviewTarget(d, key);
  const root = d.store.root;
  const path = jobPath(root, lane.key, tip);
  const existing = readJob(path);
  if (!reviewWorker(d)) {
    dropStaleJob(root, lane.key, tip);
    return { kind: "inline" };
  }
  if (existing !== undefined && opts.restart !== true) {
    const run = readRun(root, lane.key, tip);
    const state: ReviewJobState = run?.requestedAt === existing.requestedAt ? "running" : existing.state;
    return { kind: "existing", job: { ...existing, state }, state };
  }
  // A restart (or a first job over an orphaned marker) must not leave the old reviewer running beside the new one.
  const prior = killRecordedRun(root, lane.key, tip);
  if (prior.state === "failed")
    throw new Refusal(
      `cannot restart the review of lane ${lane.key} at ${tip.slice(0, 12)}: the previous reviewer could not be killed ` +
        `(${prior.why}); the job was not replaced`,
    );
  if (existing !== undefined) rmSync(path, { force: true });
  const job: ReviewJob = {
    lane: lane.key,
    tip,
    base,
    ...(model === undefined ? {} : { model }),
    requestedAt: existing === undefined ? d.now() : Math.max(d.now(), existing.requestedAt + 1),
    state: "queued",
  };
  mkdirSync(queueDir(root), { recursive: true });
  writeJson(path, job);
  return { kind: existing === undefined ? "queued" : "restarted", job };
}

const firstLine = (e: unknown): string => {
  const line = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
  return line.length > 500 ? `${line.slice(0, 500)}...` : line;
};

/** Test seams for the drain: an injectable tree killer and a shorter attempt deadline. */
export type DrainOptions = {
  readonly killTree?: KillTree;
  readonly timeoutMs?: number;
};

/**
 * Runs every queued review, oldest request first: claims the record by matching its `requestedAt`, runs the same
 * `reviewLane` the inline path runs, drops the record and tells the lead the verdict or the failure. A record a dead
 * worker left still `running` has its reviewer tree killed before this pass starts another one. A record replaced by
 * `--restart` (or removed with its lane) makes this drain stop without writing over the new job.
 */
export async function drainReviewQueue(d: Deps, opts: DrainOptions = {}): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  const root = d.store.root;
  const dir = queueDir(root);
  // A record that cannot be read as a valid job is dropped, not left to wedge every pass, so the queue heals itself.
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []) {
    if (readJob(join(dir, name)) !== undefined) continue;
    rmSync(join(dir, name), { force: true });
    const purged = killRunFile(join(dir, name.replace(/\.json$/, ".running")));
    if (purged.state === "failed") events.push({ action: "review-kill-failed", detail: `${name}: ${purged.why}` });
    events.push({ action: "review-record-dropped", detail: name });
  }
  const tell = async (text: string): Promise<void> => {
    try {
      await tellLead(d, text, "duty");
    } catch (e) {
      // The receipt and the log are the durable record; a lead pane that cannot take the message must not fail the run.
      process.stderr.write(`dori: telling the lead about a queued review failed (${failureDetail(e)})\n`);
    }
  };
  for (const listed of reviewFiles(root)) {
    const job = readJob(listed.path);
    if (job === undefined) continue;
    const prior = killRecordedRun(root, job.lane, job.tip);
    if (prior.state === "failed") {
      events.push({ lane: job.lane, action: "review-kill-failed", detail: prior.why });
      continue;
    }
    const mine = (): boolean => readJob(listed.path)?.requestedAt === job.requestedAt;
    const onReviewerPid = (pid: number | undefined): void => {
      if (!mine()) {
        if (pid === undefined) return;
        const outcome = killReviewTree(pid);
        if (!outcome.ok)
          process.stderr.write(
            `dori: review lane ${job.lane}: a reviewer spawned for a replaced job could not be killed (${outcome.why})\n`,
          );
        return;
      }
      if (pid === undefined) {
        writeRun(root, job.lane, job.tip, { requestedAt: job.requestedAt });
        return;
      }
      writeRun(root, job.lane, job.tip, { requestedAt: job.requestedAt, pid, ...reviewerIdentity(pid) });
    };
    writeRun(root, job.lane, job.tip, { requestedAt: job.requestedAt });
    try {
      const review = await reviewLane(d, job.lane, job.model, {
        ...(opts.killTree === undefined ? {} : { killTree: opts.killTree }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        checkLive: () => {
          if (!mine()) throw new ReviewCancelled();
        },
        onReviewerPid,
      });
      if (liveRun(root, job.lane, job.tip, job.requestedAt)) {
        events.push({ lane: job.lane, action: "review-kill-failed", detail: KILL_FAILED_KEPT });
        continue;
      }
      if (!finishJob(listed.path, job.requestedAt)) {
        clearRun(root, job.lane, job.tip, job.requestedAt);
        events.push({ lane: job.lane, action: "review-cancelled" });
        continue;
      }
      clearRun(root, job.lane, job.tip, job.requestedAt);
      const receipt = d.store.receipts.laneReceiptPath(job.lane, review.tip);
      await tell(`[REVIEW ${job.lane}] ${review.verdict} at ${review.tip}; receipt ${receipt}`);
      events.push({ lane: job.lane, action: "review-done", detail: `${review.verdict} at ${review.tip}` });
    } catch (e) {
      if (e instanceof ReviewCancelled) {
        clearRun(root, job.lane, job.tip, job.requestedAt);
        events.push({ lane: job.lane, action: "review-cancelled" });
        continue;
      }
      if (liveRun(root, job.lane, job.tip, job.requestedAt)) {
        events.push({ lane: job.lane, action: "review-kill-failed", detail: KILL_FAILED_KEPT });
        continue;
      }
      if (!finishJob(listed.path, job.requestedAt)) {
        clearRun(root, job.lane, job.tip, job.requestedAt);
        events.push({ lane: job.lane, action: "review-cancelled" });
        continue;
      }
      // A failed or timed-out review posts like a verdict: the lead must never wait for a message that will not come.
      clearRun(root, job.lane, job.tip, job.requestedAt);
      const why = firstLine(e);
      await tell(`[REVIEW ${job.lane}] failed at ${job.tip}: ${why}`);
      events.push({ lane: job.lane, action: "review-failed", detail: why });
    }
  }
  return events;
}

export { reviewJobFor, reviewJobId } from "./review-job.ts";
