// The worker half of a background review: the command a review session runs. It writes the same receipt the
// foreground `dori review <PR>` writes, keeps a progress row while the reviewer runs, and has no deadline of its own.

import { appendFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import { loadReviewSettings } from "./hooks.ts";
import { HOSTNAME, processStartTime } from "./process-identity.ts";
import { Refusal } from "./refusal.ts";
import { review, type ReviewOutput } from "./review-pr.ts";
import {
  announceRun,
  firstLine,
  JOB_RE,
  lastNonEmptyLine,
  readRunJob,
  REVIEW_PROGRESS_MS,
  reviewLogPath,
  runPath,
  runsDir,
  type ReviewRunJob,
  writeRunJob,
} from "./review-run.ts";

/** At most one progress write per second of a reviewer that streams output, plus the periodic heartbeat. */
const PROGRESS_WRITE_MS = 1000;

export type RunReviewOptions = { readonly progressMs?: number | undefined };

/**
 * Reviews the PR, writes the receipt through the same `review()` the foreground command uses, keeps a progress row
 * while it runs, and records the verdict or failure. It ends when the reviewer ends, never at a deadline.
 */
export async function runReviewJob(d: Deps, id: string, opts: RunReviewOptions = {}): Promise<ReviewRunJob> {
  if (!JOB_RE.test(id)) throw new Refusal(`invalid review job id ${id}`);
  const path = runPath(d.store.root, id);
  const initial = readRunJob(path);
  if (initial === undefined) throw new Refusal(`no review job ${id} under ${runsDir(d.store.root)}`);
  if (initial.state === "done" || initial.state === "failed") return initial;

  let current: ReviewRunJob = {
    ...initial,
    state: "running",
    workerPid: process.pid,
    host: HOSTNAME,
    startTime: processStartTime(process.pid),
    heartbeatAt: d.now(),
  };
  writeRunJob(d.store.root, current);
  const logPath = reviewLogPath(d.store.root, id);
  let bytes = initial.bytes ?? 0;
  let lastLine = initial.lastLine;
  let lastOutputAt = initial.lastOutputAt;
  let lastWriteAt = 0;
  const progressFields = (): Partial<Pick<ReviewRunJob, "bytes" | "lastLine" | "lastOutputAt">> => ({
    bytes,
    ...(lastLine === undefined ? {} : { lastLine }),
    ...(lastOutputAt === undefined ? {} : { lastOutputAt }),
  });
  const persist = (patch: Partial<ReviewRunJob>): void => {
    // Duty may have written `slowNotifiedAt` or `announcedAt` while this worker runs; merge, never overwrite.
    const latest = readRunJob(path) ?? current;
    current = { ...latest, ...patch };
    writeRunJob(d.store.root, current);
  };
  const onOutput = (out: ReviewOutput): void => {
    bytes += out.chunk.length;
    lastOutputAt = d.now();
    const line = lastNonEmptyLine(out.chunk);
    if (line !== undefined) lastLine = line;
    try {
      appendFileSync(logPath, out.chunk);
    } catch {
      // The progress row still carries the byte count and the last line when the log is unwritable.
    }
    // Streaming output is throttled; the heartbeat below is the periodic record even when the reviewer is silent.
    if (d.now() - lastWriteAt >= PROGRESS_WRITE_MS) {
      lastWriteAt = d.now();
      persist(progressFields());
    }
  };
  const timer = setInterval(
    () => persist({ ...progressFields(), heartbeatAt: d.now() }),
    opts.progressMs ?? REVIEW_PROGRESS_MS,
  );
  timer.unref?.();
  try {
    const result = await review(d, initial.pr, initial.model ?? loadReviewSettings(d.store.root).model, { onOutput });
    persist({
      state: "done",
      verdict: result.verdict,
      sha: result.sha,
      ...progressFields(),
      heartbeatAt: d.now(),
      finishedAt: d.now(),
    });
    await announceRun(d, current);
    return current;
  } catch (e) {
    persist({
      state: "failed",
      error: firstLine(e),
      ...progressFields(),
      heartbeatAt: d.now(),
      finishedAt: d.now(),
    });
    await announceRun(d, current);
    return current;
  } finally {
    clearInterval(timer);
  }
}
