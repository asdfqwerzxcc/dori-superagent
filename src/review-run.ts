// A background review's record: what to review, which session and process carry it, where its output goes, and the
// last progress row duty may report. There is no deadline in this model; `slowNotifiedAt` and `announcedAt` only make
// the two notices happen once.

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPrId } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { memoryLow } from "./host.ts";
import { tellLead } from "./inbox.ts";
import { readJson, writeJson } from "./json-file.ts";
import { HOSTNAME, pidAlive, processStartTime } from "./process-identity.ts";
import type { HostLoad } from "./store-types.ts";

/** Rough private memory one reviewer holds; it sizes how many reviews may run at once, and nothing else. */
export const REVIEW_MEM_MB = 500;
/** A review that has run this long is reported to the lead once. It is never stopped, shortened or failed for age. */
export const REVIEW_SLOW_MS = 2 * 60 * 60 * 1000;
/** How often a running worker rewrites its progress row. */
export const REVIEW_PROGRESS_MS = 30_000;

export const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const STATES = new Set<RunState>(["starting", "running", "done", "failed"]);

/** `starting` until the session is up, `running` while the worker writes the receipt, then one terminal state. */
export type RunState = "starting" | "running" | "done" | "failed";

/** One background review: its PR, state, log, carrying session/process, and the last progress row. */
export type ReviewRunJob = {
  readonly job: string;
  readonly pr: string;
  readonly model?: string;
  readonly state: RunState;
  readonly startedAt: number;
  readonly log: string;
  readonly session?: string;
  readonly workerPid?: number;
  readonly host?: string;
  readonly startTime?: number | null;
  readonly lastOutputAt?: number;
  readonly lastLine?: string;
  readonly bytes?: number;
  readonly heartbeatAt?: number;
  readonly sha?: string;
  readonly verdict?: "CLEAR" | "BLOCK";
  readonly error?: string;
  readonly finishedAt?: number;
  readonly slowNotifiedAt?: number;
  readonly announcedAt?: number;
  readonly sessionClosedAt?: number;
};

export const runsDir = (root: string): string => join(root, "state", "reviews", "jobs");
export const reviewLogPath = (root: string, job: string): string => join(root, "state", "reviews", `${job}.log`);
export const runPath = (root: string, job: string): string => join(runsDir(root), `${job}.json`);

const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown): boolean =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));
const optionalStartTime = (value: unknown): boolean => value === null || optionalNumber(value);

/** A record must hold a job this code may act on; anything else is dropped like a corrupt queue record. */
function validRunJob(job: ReviewRunJob): boolean {
  if (typeof job.job !== "string" || !JOB_RE.test(job.job)) return false;
  if (typeof job.pr !== "string" || !isPrId(job.pr)) return false;
  if (typeof job.log !== "string" || !Number.isFinite(job.startedAt) || !STATES.has(job.state)) return false;
  return (
    optionalString(job.model) &&
    optionalString(job.session) &&
    optionalString(job.host) &&
    optionalString(job.lastLine) &&
    optionalString(job.sha) &&
    optionalString(job.error) &&
    (job.verdict === undefined || job.verdict === "CLEAR" || job.verdict === "BLOCK") &&
    optionalNumber(job.workerPid) &&
    optionalStartTime(job.startTime) &&
    optionalNumber(job.lastOutputAt) &&
    optionalNumber(job.bytes) &&
    optionalNumber(job.heartbeatAt) &&
    optionalNumber(job.finishedAt) &&
    optionalNumber(job.slowNotifiedAt) &&
    optionalNumber(job.announcedAt) &&
    optionalNumber(job.sessionClosedAt)
  );
}

export const readRunJob = (path: string): ReviewRunJob | undefined => {
  try {
    const job = readJson<ReviewRunJob>(path);
    return job !== undefined && validRunJob(job) ? job : undefined;
  } catch {
    return undefined;
  }
};

export const writeRunJob = (root: string, job: ReviewRunJob): void => {
  const path = runPath(root, job.job);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, job);
};

/** Every readable job, oldest first. The file name and the record's own id must agree. */
export function runFiles(root: string): { path: string; job: ReviewRunJob }[] {
  let names: string[];
  try {
    names = readdirSync(runsDir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const path = join(runsDir(root), name);
      const job = readRunJob(path);
      return job === undefined || name !== `${job.job}.json` ? [] : [{ path, job }];
    })
    .sort((a, b) => a.job.startedAt - b.job.startedAt || a.job.job.localeCompare(b.job.job));
}

export const activeJobs = (root: string): ReviewRunJob[] =>
  runFiles(root)
    .map(({ job }) => job)
    .filter((job) => job.state === "starting" || job.state === "running");

/**
 * How many reviewers this host may run at once: free memory divided by one reviewer's private footprint, and zero
 * when free memory is already below the floor every agent shares. Nothing in this decision reads a clock.
 */
export const reviewCapacity = (host: HostLoad): number =>
  memoryLow(host) ? 0 : Math.max(0, Math.floor(host.memFreeMb / REVIEW_MEM_MB));

export const firstLine = (e: unknown): string => {
  const text = e instanceof Error ? e.message : String(e);
  const line = text.split("\n")[0] ?? text;
  return line.length > 240 ? `${line.slice(0, 240)}...` : line;
};

export const duration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
};

/** ESC itself is built from its code so the linter never sees a control character in source. */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** The last non-empty line of a chunk, with ANSI colour stripped: the closest thing a non-interactive reviewer has to "last tool call". */
export function lastNonEmptyLine(chunk: string): string | undefined {
  const clean = chunk.replace(ANSI_RE, "");
  const line = clean
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .at(-1);
  return line === undefined ? undefined : line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

export const progressOf = (job: ReviewRunJob): string => {
  const stamp =
    job.lastOutputAt === undefined ? "no output yet" : `last output ${new Date(job.lastOutputAt).toISOString()}`;
  const line = job.lastLine === undefined ? "" : `; last line ${JSON.stringify(job.lastLine)}`;
  return `${stamp}; ${job.bytes ?? 0} B captured${line}`;
};

/** A worker is only the process this record names: same host, same start time, still alive. */
export const workerAlive = (job: ReviewRunJob): boolean => {
  if (job.workerPid === undefined || job.host !== HOSTNAME || !pidAlive(job.workerPid)) return false;
  const startTime = processStartTime(job.workerPid);
  return startTime !== null && (job.startTime === undefined || job.startTime === null || startTime === job.startTime);
};

/** `o/r#7` -> `o-r-7-<suffix>`: a file name, never a path. */
export function reviewRunId(pr: string): string {
  const slug = pr
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

/** Sends the one terminal message a job deserves. Returns true when this call wrote it. */
export async function announceRun(d: Deps, job: ReviewRunJob): Promise<boolean> {
  if (job.state !== "done" && job.state !== "failed") return false;
  const path = runPath(d.store.root, job.job);
  const current = readRunJob(path);
  if (current === undefined || current.announcedAt !== undefined) return false;
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
    if (sent === undefined) return false;
    writeRunJob(d.store.root, { ...current, announcedAt: d.now() });
    return true;
  } catch {
    // The lead pane may be restarting; duty retries the same notice on its next pass.
    return false;
  }
}
