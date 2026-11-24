// The review request queue: `dori review --lane` records the lane's tip and diff and prints QUEUED, then returns.
// A reviewer session (started from `dori review <owner/repo#N>`) records its verdict with `dori review <key> --attest`.
// Duty never spawns a reviewer: its drain only reports a waiting request and expires one that never got a receipt.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { writeJson } from "./json-file.ts";
import { laneGit } from "./lane-repo.ts";
import { laneReviewTarget } from "./lane-review-target.ts";
import { Refusal } from "./refusal.ts";
import {
  finishJob,
  jobPath,
  killRecordedRun,
  killRunFile,
  legacyKillEnabled,
  queueDir,
  readJob,
  readRun,
  reviewFiles,
  type ReviewJob,
  type ReviewJobState,
} from "./review-job.ts";

/** A drain result, shaped like a duty event so `dori duty` prints it with every other line. */
export type ReviewEvent = {
  readonly lane?: string;
  readonly action: "review-queued" | "review-expired" | "review-record-dropped" | "review-kill-failed";
  readonly detail?: string;
};

/** What a `dori review --lane` call did: a fresh request, a replacement, or the request already on disk. */
export type QueueOutcome =
  | { readonly kind: "queued"; readonly job: ReviewJob }
  | { readonly kind: "restarted"; readonly job: ReviewJob }
  | { readonly kind: "existing"; readonly job: ReviewJob; readonly state: ReviewJobState };

/** A request older than this is expired by the duty drain: no receipt is coming, so the lane is free to queue again. */
export const REVIEW_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/** `DORI_REVIEW_QUEUE_TTL_MS` when set to a positive number, else the 24-hour TTL. */
export function reviewQueueTtlFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env["DORI_REVIEW_QUEUE_TTL_MS"]);
  return Number.isFinite(ms) && ms >= 1 ? ms : REVIEW_QUEUE_TTL_MS;
}

/**
 * The queue side of `dori review --lane`: writes the full `base..tip` diff, records the request atomically and hands
 * it back. A request for the same lane+tip while one is queued returns that record and never a second request;
 * `--restart` replaces it. Nothing is spawned here: the caller returns at once and the lead reviews it in `dori review`.
 */
export async function queueLaneReview(
  d: Deps,
  key: string,
  model: string | undefined,
  opts: { readonly restart?: boolean; readonly legacyKill?: boolean } = {},
): Promise<QueueOutcome> {
  const { lane, repo, tip, base } = await laneReviewTarget(d, key);
  const diff = await laneGit(d, repo, ["--no-pager", "diff", "--no-color", "--no-ext-diff", `${base}..${tip}`]);
  if (diff.code !== 0)
    throw new Refusal(
      `git diff ${base.slice(0, 12)}..${tip.slice(0, 12)} failed: ${(diff.stderr || diff.stdout).trim()}`,
    );
  writeFileSync(d.store.laneDiffPath(lane.key, tip), diff.stdout);
  const root = d.store.root;
  const path = jobPath(root, lane.key, tip);
  const existing = readJob(path);
  const expired = existing !== undefined && d.now() - existing.requestedAt >= reviewQueueTtlFromEnv();
  const replacing = opts.restart === true || expired;
  if (existing !== undefined && !replacing) {
    const run = readRun(root, lane.key, tip);
    const state: ReviewJobState = run?.requestedAt === existing.requestedAt ? "running" : existing.state;
    return { kind: "existing", job: existing, state };
  }
  // Only the explicit legacy path may touch a reviewer an older dori recorded; the default replaces the record only.
  if (replacing && legacyKillEnabled(process.env, opts.legacyKill)) {
    const prior = killRecordedRun(root, lane.key, tip);
    if (prior.state === "failed")
      throw new Refusal(
        `cannot replace the review request for lane ${lane.key} at ${tip.slice(0, 12)}: the legacy reviewer could not ` +
          `be killed (${prior.why}); the request was not replaced`,
      );
  }
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
  const current = d.store.lane(lane.key);
  if (current !== undefined) {
    current.tipSha = tip;
    d.store.saveLane(current);
  }
  return { kind: opts.restart === true && existing !== undefined ? "restarted" : "queued", job };
}

const ageOf = (ms: number): string => `${Math.floor(Math.max(0, ms) / 60_000)}m`;

/** Test seams for the drain: a shorter TTL, and the legacy kill switch for markers an older dori left behind. */
export type DrainOptions = {
  readonly legacyKill?: boolean;
  readonly ttlMs?: number;
};

/**
 * The duty side of the queue: reports each waiting request and expires one that is older than the TTL. It reads and
 * writes records only; it never spawns a reviewer, runs git, or sends an inbox message. A record that cannot be read
 * as a valid job is dropped so it cannot wedge the queue, and its legacy marker is left for the explicit legacy path.
 */
export async function drainReviewQueue(d: Deps, opts: DrainOptions = {}): Promise<ReviewEvent[]> {
  const events: ReviewEvent[] = [];
  const root = d.store.root;
  const dir = queueDir(root);
  const legacy = legacyKillEnabled(process.env, opts.legacyKill);
  const ttlMs = opts.ttlMs ?? reviewQueueTtlFromEnv();
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []) {
    if (readJob(join(dir, name)) !== undefined) continue;
    rmSync(join(dir, name), { force: true });
    if (legacy) {
      const purged = killRunFile(join(dir, name.replace(/\.json$/, ".running")));
      if (purged.state === "failed") events.push({ action: "review-kill-failed", detail: `${name}: ${purged.why}` });
    }
    events.push({ action: "review-record-dropped", detail: name });
  }
  for (const { path, job } of reviewFiles(root)) {
    const age = d.now() - job.requestedAt;
    if (age < ttlMs) {
      events.push({
        lane: job.lane,
        action: "review-queued",
        detail: `waiting ${ageOf(age)} for the lead's receipt`,
      });
      continue;
    }
    if (!finishJob(path, job.requestedAt)) continue;
    if (legacy) {
      const run = readRun(root, job.lane, job.tip);
      if (run !== undefined && run.requestedAt === job.requestedAt) {
        const killed = killRecordedRun(root, job.lane, job.tip);
        if (killed.state === "failed")
          events.push({ lane: job.lane, action: "review-kill-failed", detail: killed.why });
      }
    }
    events.push({
      lane: job.lane,
      action: "review-expired",
      detail: `requested ${ageOf(age)} ago with no receipt; record removed`,
    });
  }
  return events;
}

export { reviewJobFor, reviewJobId } from "./review-job.ts";
