// The on-disk review request: what `dori review --lane` records, and what the lead's attestation consumes. The queue
// never runs a reviewer itself; the record is the handoff between the lead's request and the lead's receipt. The
// sibling `.running` marker is legacy only: an older dori spawned a reviewer and recorded its identity there so a
// legacy `--restart` (or a lane drop with the legacy flag) can kill exactly that tree, never a pid it cannot prove.

import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./json-file.ts";
import { HOSTNAME, pidAlive, processStartTime } from "./process-identity.ts";
import { killReviewTree } from "./review-kill.ts";
import { KEY_RE } from "./store-types.ts";

export type ReviewJobState = "queued" | "running";
/** One lane review waiting for the lead: what to review, with which model, when it was asked for, and its state. */
export type ReviewJob = {
  readonly lane: string;
  readonly tip: string;
  readonly base: string;
  readonly model?: string;
  readonly requestedAt: number;
  readonly state: ReviewJobState;
};
/**
 * The legacy live half of a job: the reviewer tree an older drain started, so `--restart --legacy-kill` can end it.
 * `host` and `startTime` make the pid an identity: a marker that survives a reboot (or reaches a shared home from
 * another host) names no process this machine may kill. `startTime` is null when the OS could not report it, and the
 * marker then fails closed.
 */
export type ReviewRun = {
  readonly requestedAt: number;
  readonly pid?: number;
  readonly host?: string;
  readonly startTime?: number | null;
};

/** What happened when a recorded reviewer was cleaned up: an unprovable marker, a kill, or a failed kill. */
export type RunKill =
  | { readonly state: "stale" }
  | { readonly state: "killed" }
  | { readonly state: "failed"; readonly why: string };

const SHA_RE = /^[0-9a-f]{7,64}$/;
export const queueDir = (root: string): string => join(root, "state", "review-queue");

const validId = (lane: string, tip: string): boolean => KEY_RE.test(lane) && SHA_RE.test(tip);

/** A record must hold a job this code can consume: valid lane and tip, a base, a finite request time and a known state. */
const validJob = (j: ReviewJob): boolean =>
  validId(j.lane, j.tip) &&
  typeof j.base === "string" &&
  Number.isFinite(j.requestedAt) &&
  (j.state === "queued" || j.state === "running") &&
  (j.model === undefined || typeof j.model === "string");

/** A marker is readable only when every field it carries has the documented shape; unknown fields are ignored. */
const validRun = (run: ReviewRun): boolean => {
  if (!Number.isFinite(run.requestedAt)) return false;
  if (run.pid !== undefined && !(Number.isInteger(run.pid) && run.pid > 0)) return false;
  if (run.host !== undefined && typeof run.host !== "string") return false;
  if (run.startTime !== undefined && run.startTime !== null && !Number.isFinite(run.startTime)) return false;
  return true;
};

/** `<lane>@<tip>`: a job's id and its file name; both halves are checked so a record can never land outside the queue. */
export function reviewJobId(lane: string, tip: string): string {
  if (!validId(lane, tip)) throw new Error(`invalid review job ${lane}@${tip}`);
  return `${lane}@${tip}`;
}

export const jobPath = (root: string, lane: string, tip: string): string =>
  join(queueDir(root), `${reviewJobId(lane, tip)}.json`);

/** Not a `.json` file, so the corrupt-record sweep and the job listing never mistake a running marker for a job. */
export const runPath = (root: string, lane: string, tip: string): string =>
  join(queueDir(root), `${reviewJobId(lane, tip)}.running`);

/** A record read without trusting its bytes or its fields: anything not a valid job reads as absent. */
export const readJob = (path: string): ReviewJob | undefined => {
  try {
    const job = readJson<ReviewJob>(path);
    return job !== undefined && validJob(job) ? job : undefined;
  } catch {
    return undefined;
  }
};

/** Every readable job with the file it came from, oldest request first; the drain drops whatever reads as absent. */
export function reviewFiles(root: string): { path: string; job: ReviewJob }[] {
  const dir = queueDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const path = join(dir, f);
      const job = readJob(path);
      return job === undefined ? [] : [{ path, job }];
    })
    .sort((a, b) => a.job.requestedAt - b.job.requestedAt || a.job.lane.localeCompare(b.job.lane));
}

/** The pending job for exactly this lane and tip, `corrupt` when a record exists but cannot be read, or undefined. */
export function reviewJobFor(root: string, lane: string, tip: string): ReviewJob | "corrupt" | undefined {
  if (!validId(lane, tip)) return undefined;
  const path = jobPath(root, lane, tip);
  if (!existsSync(path)) return undefined;
  const job = readJob(path);
  if (job === undefined) return "corrupt";
  const run = readRun(root, lane, tip);
  return run !== undefined && run.requestedAt === job.requestedAt ? { ...job, state: "running" } : job;
}

export const readRun = (root: string, lane: string, tip: string): ReviewRun | undefined => {
  if (!validId(lane, tip)) return undefined;
  try {
    const run = readJson<ReviewRun>(runPath(root, lane, tip));
    return run !== undefined && validRun(run) ? run : undefined;
  } catch {
    return undefined;
  }
};

/** True only for the exact process a legacy marker recorded: same host, same start time, still alive. */
const sameProcess = (run: ReviewRun): boolean => {
  if (run.pid === undefined || run.host !== HOSTNAME) return false;
  if (run.startTime === undefined || run.startTime === null) return false;
  if (!pidAlive(run.pid)) return false;
  const startTime = processStartTime(run.pid);
  return startTime !== null && startTime === run.startTime;
};

/**
 * Kills the reviewer a recorded legacy marker names, but only after proving it is the same process; an unprovable,
 * foreign, dead or reused pid drops the marker without touching anything. A failed kill keeps the marker so a later
 * legacy pass can retry, and reports why. Callers gate this behind the legacy flag: the default path spawns nothing.
 */
function killMarker(path: string, run: ReviewRun | undefined): RunKill {
  if (run === undefined) {
    rmSync(path, { force: true });
    return { state: "stale" };
  }
  const pid = run.pid;
  if (pid === undefined || !sameProcess(run)) {
    rmSync(path, { force: true });
    return { state: "stale" };
  }
  const outcome = killReviewTree(pid);
  if (!outcome.ok) return { state: "failed", why: outcome.why };
  rmSync(path, { force: true });
  return { state: "killed" };
}

/** Kills the reviewer an older dori left at this lane+tip (verified by host and start time) and clears the marker. */
export function killRecordedRun(root: string, lane: string, tip: string): RunKill {
  const run = readRun(root, lane, tip);
  return killMarker(runPath(root, lane, tip), run);
}

/** Kills the reviewer named by a raw running marker (a record too corrupt to read still owns its reviewer). */
export function killRunFile(path: string): RunKill {
  let run: ReviewRun | undefined;
  try {
    const parsed = readJson<ReviewRun>(path);
    run = parsed !== undefined && validRun(parsed) ? parsed : undefined;
  } catch {
    run = undefined;
  }
  return killMarker(path, run);
}

/**
 * Deletes the job record only when it is still the `requestedAt` the caller claimed. A restart that wrote a new
 * record at the same path is put back (a hard link cannot overwrite), so the slow finish can never erase it.
 */
export function finishJob(path: string, requestedAt: number): boolean {
  const tomb = `${path}.done.${randomUUID()}`;
  try {
    renameSync(path, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  const moved = readJob(tomb);
  if (moved !== undefined && moved.requestedAt === requestedAt) {
    rmSync(tomb, { force: true });
    return true;
  }
  try {
    linkSync(tomb, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      rmSync(tomb, { force: true });
      return false;
    }
    const why = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "restore failed";
    process.stderr.write(
      `dori: could not restore the review job record at ${path} (${why}); the record is kept at ${tomb}\n`,
    );
    return false;
  }
  rmSync(tomb, { force: true });
  return false;
}

/**
 * `true` when a caller asked for the legacy reviewer-tree cleanup, by flag or by `DORI_REVIEW_LEGACY_KILL=1`.
 * The default path only replaces request records; an older dori's live reviewer is left for this explicit path.
 */
export const legacyKillEnabled = (env: NodeJS.ProcessEnv = process.env, flag = false): boolean =>
  flag || env["DORI_REVIEW_LEGACY_KILL"] === "1";

/** A lane being dropped has no review left worth waiting for: stop its legacy reviewer (with the flag) and forget it. */
export function cancelLaneReviews(root: string, lane: string, opts: { readonly legacyKill?: boolean } = {}): string[] {
  const failures: string[] = [];
  for (const { path, job } of reviewFiles(root)) {
    if (job.lane !== lane) continue;
    if (opts.legacyKill === true) {
      const killed = killRecordedRun(root, lane, job.tip);
      if (killed.state === "failed") {
        failures.push(`${job.tip}: ${killed.why}`);
        continue;
      }
    }
    rmSync(path, { force: true });
  }
  return failures;
}
