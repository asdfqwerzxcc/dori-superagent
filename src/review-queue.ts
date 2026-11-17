// The review queue: `dori review --lane` records what to review and returns, so the lead that asked is never held for
// the reviewer's deadline. The duty worker drains the records in its own pane and tells the lead the verdict.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failureDetail } from "./delivery.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { readJson, writeJson } from "./json-file.ts";
import { laneReviewTarget, reviewLane } from "./lane-review.ts";
import { lockLive } from "./loop-lock.ts";
import { KEY_RE } from "./store-types.ts";

export type ReviewJobState = "queued" | "running";

/** One lane review waiting for the duty worker: what to review, with which model, when it was asked for, and its state. */
export type ReviewJob = {
  readonly lane: string;
  readonly tip: string;
  readonly base: string;
  readonly model?: string;
  readonly requestedAt: number;
  readonly state: ReviewJobState;
};

/** A drain result, shaped like a duty event so `dori duty` prints it with every other line. */
export type ReviewEvent = {
  readonly lane: string;
  readonly action: "review-done" | "review-failed";
  readonly detail?: string;
};

const SHA_RE = /^[0-9a-f]{7,64}$/;
const queueDir = (root: string): string => join(root, "state", "review-queue");

const validId = (lane: string, tip: string): boolean => KEY_RE.test(lane) && SHA_RE.test(tip);

/** `<lane>@<tip>`: a job's id and its file name; both halves are checked so a record can never land outside the queue. */
export function reviewJobId(lane: string, tip: string): string {
  if (!validId(lane, tip)) throw new Error(`invalid review job ${lane}@${tip}`);
  return `${lane}@${tip}`;
}

const jobPath = (root: string, lane: string, tip: string): string =>
  join(queueDir(root), `${reviewJobId(lane, tip)}.json`);

/** Every pending job, oldest request first; an unreadable record is ignored like a store record is. */
function reviewJobs(root: string): ReviewJob[] {
  const dir = queueDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<ReviewJob>(join(dir, f)))
    .filter((j): j is ReviewJob => j !== undefined)
    .sort((a, b) => a.requestedAt - b.requestedAt || a.lane.localeCompare(b.lane));
}

/** The pending job for exactly this lane and tip, or undefined (including for a pair that could never be a job). */
export function reviewJobFor(root: string, lane: string, tip: string): ReviewJob | undefined {
  return validId(lane, tip) ? readJson<ReviewJob>(jobPath(root, lane, tip)) : undefined;
}

/** True while a duty loop runs in this home: its lock is held by a process that is alive on this host. */
const reviewWorker = (d: Deps): boolean => lockLive(d.store.lockPath("duty"));

/**
 * The queue side of `dori review --lane`: with a duty loop running, records the job atomically and hands it back (a
 * second request for the same lane+tip gets the record already there, never a second reviewer). With no worker it
 * drops a record a dead worker left for this lane+tip and returns undefined, so the caller reviews inline instead.
 */
export async function queueLaneReview(d: Deps, key: string, model: string | undefined): Promise<ReviewJob | undefined> {
  const target = await laneReviewTarget(d, key);
  const path = jobPath(d.store.root, target.lane.key, target.tip);
  if (!reviewWorker(d)) {
    // The inline review below is this lane+tip's review: a record left by a worker that died would only run it twice.
    rmSync(path, { force: true });
    return undefined;
  }
  const existing = readJson<ReviewJob>(path);
  if (existing !== undefined) return existing;
  const job: ReviewJob = {
    lane: target.lane.key,
    tip: target.tip,
    base: target.base,
    ...(model === undefined ? {} : { model }),
    requestedAt: d.now(),
    state: "queued",
  };
  mkdirSync(queueDir(d.store.root), { recursive: true });
  writeJson(path, job);
  return job;
}

const firstLine = (e: unknown): string => {
  const line = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
  return line.length > 500 ? `${line.slice(0, 500)}...` : line;
};

/**
 * Runs every queued review, oldest request first: claims the record, runs the same `reviewLane` the inline path runs,
 * drops the record and tells the lead the verdict or the failure with the receipt path. There is one duty worker per
 * home, so a record still `running` when a pass starts was left by a dead worker: this pass runs it again.
 */
export async function drainReviewQueue(d: Deps): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  const tell = async (text: string): Promise<void> => {
    try {
      await tellLead(d, text, "duty");
    } catch (e) {
      // The receipt and the log are the durable record; a lead pane that cannot take the message must not fail the run.
      process.stderr.write(`dori: telling the lead about a queued review failed (${failureDetail(e)})\n`);
    }
  };
  for (const listed of reviewJobs(d.store.root)) {
    const path = jobPath(d.store.root, listed.lane, listed.tip);
    const job = readJson<ReviewJob>(path);
    if (job === undefined) continue;
    writeJson(path, { ...job, state: "running" });
    try {
      const review = await reviewLane(d, job.lane, job.model);
      rmSync(path, { force: true });
      const receipt = d.store.receipts.laneReceiptPath(job.lane, review.tip);
      await tell(`[REVIEW ${job.lane}] ${review.verdict} at ${review.tip}; receipt ${receipt}`);
      events.push({ lane: job.lane, action: "review-done", detail: `${review.verdict} at ${review.tip}` });
    } catch (e) {
      // A failed or timed-out review posts like a verdict: the lead must never wait for a message that will not come.
      rmSync(path, { force: true });
      const why = firstLine(e);
      await tell(`[REVIEW ${job.lane}] failed at ${job.tip}: ${why}`);
      events.push({ lane: job.lane, action: "review-failed", detail: why });
    }
  }
  return events;
}
