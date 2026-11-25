// Session, marker and retention sidecars for background review jobs: the tab a start opened, the once-only slow and
// announced claims, terminal-row pruning, and the one terminal message a job deserves. Kept apart from the record
// module so each stays inside the 250-line rule.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { readJson, writeJson } from "./json-file.ts";
import {
  duration,
  readRunJob,
  reviewLogPath,
  runFiles,
  runPath,
  runsDir,
  type ReviewRunJob,
  writeRunJob,
} from "./review-run.ts";

/** Terminal job rows and logs kept for diagnostics; receipts are kept separately. */
export const REVIEW_RETENTION_KEEP = 20;
export const REVIEW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The review tab a start opened, kept beside the row so the session write cannot race the worker's first write. */
export const sessionPath = (root: string, job: string): string => join(runsDir(root), `${job}.session`);

export function writeSessionRef(root: string, job: string, session: string): void {
  mkdirSync(runsDir(root), { recursive: true });
  writeJson(sessionPath(root, job), { session });
}

export function readSessionRef(root: string, job: string): string | undefined {
  try {
    const value = readJson<{ session?: unknown }>(sessionPath(root, job));
    return typeof value?.session === "string" ? value.session : undefined;
  } catch {
    return undefined;
  }
}

export type MarkerKind = "slow" | "announced";
const markerPath = (root: string, job: string, kind: MarkerKind): string => join(runsDir(root), `${job}.${kind}`);

/** `wx` makes the claim a single winner across duty passes and worker writes; a failed send releases it. */
export function claimMarker(root: string, job: string, kind: MarkerKind): boolean {
  try {
    mkdirSync(runsDir(root), { recursive: true });
    writeFileSync(markerPath(root, job, kind), "", { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

export const releaseMarker = (root: string, job: string, kind: MarkerKind): void =>
  rmSync(markerPath(root, job, kind), { force: true });

/** Drops old terminal rows and logs; a running/starting review is never pruned. Receipts are kept separately. */
export function pruneRuns(
  root: string,
  now: number,
  keep: number = REVIEW_RETENTION_KEEP,
  maxAgeMs: number = REVIEW_RETENTION_MS,
): string[] {
  const terminal = runFiles(root)
    .map(({ job }) => job)
    .filter((job) => job.state === "done" || job.state === "failed")
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
  const excess = Math.max(0, terminal.length - keep);
  const removed: string[] = [];
  for (const [index, job] of terminal.entries()) {
    const at = job.finishedAt ?? job.startedAt;
    if (index >= excess && now - at < maxAgeMs) continue;
    rmSync(runPath(root, job.job), { force: true });
    rmSync(reviewLogPath(root, job.job), { force: true });
    rmSync(sessionPath(root, job.job), { force: true });
    releaseMarker(root, job.job, "slow");
    releaseMarker(root, job.job, "announced");
    removed.push(job.job);
  }
  return removed;
}

/** Sends the one terminal message a job deserves. Returns true when this call wrote it. */
export async function announceRun(d: Deps, job: ReviewRunJob): Promise<boolean> {
  if (job.state !== "done" && job.state !== "failed") return false;
  const path = runPath(d.store.root, job.job);
  const current = readRunJob(path);
  if (current === undefined || current.announcedAt !== undefined) return false;
  if (!claimMarker(d.store.root, current.job, "announced")) return false;
  const elapsed = duration(d.now() - current.startedAt);
  const text =
    current.state === "done"
      ? `[REVIEW ${current.pr}] ${current.verdict ?? "?"} receipt at ${current.sha?.slice(0, 12) ?? "?"} ` +
        `(job ${current.job}, ${elapsed}); record the lane receipt with dori review <lane-key> --attest --verdict ` +
        `CLEAR|BLOCK --reviewer <reviewer> --evidence <report>, then dori merge <lane-key>`
      : `[REVIEW ${current.pr}] failed after ${elapsed} (job ${current.job}): ${current.error ?? "no reason given"}; ` +
        `log ${current.log}`;
  try {
    const sent = await tellLead(d, text, "review");
    if (sent === undefined) {
      releaseMarker(d.store.root, current.job, "announced");
      return false;
    }
    writeRunJob(d.store.root, { ...current, announcedAt: d.now() });
    return true;
  } catch {
    // The lead pane may be restarting; duty retries the same notice on its next pass.
    releaseMarker(d.store.root, current.job, "announced");
    return false;
  }
}
