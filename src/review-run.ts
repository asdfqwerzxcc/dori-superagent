// One reviewer process, bounded: its output is streamed to a log, a periodic line says it is still alive, and a run that
// outlives its deadline is killed and reported as a timeout instead of hanging the command that asked for a receipt.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./runtime/exec.ts";

/** The default reviewer deadline: long enough for a real review, short enough that a hung provider fails the lane. */
export const REVIEW_TIMEOUT_MS = 600_000;
/** How often a still-running reviewer says so, so a lead can tell "slow" from "dead". */
export const REVIEW_PROGRESS_MS = 30_000;
/** After the kill, how long to wait for the process to report an exit code; the timeout stands either way. */
const KILL_GRACE_MS = 250;

export type ReviewVerdict = "CLEAR" | "BLOCK";

/** Where one lane's reviewer output is streamed across every run and chunk of `dori review --lane`. */
export const reviewLogPath = (root: string, key: string): string => join(root, "state", "reviews", `${key}.log`);

export type ReviewOutcome =
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "timeout"; readonly stdout: string; readonly stderr: string; readonly code?: number };

export type ReviewerRun = {
  readonly exec: Exec;
  readonly cmd: string;
  readonly argv: readonly string[];
  /** Appended to, never truncated: every chunk of a chunked review lands in the same lane log. */
  readonly log: string;
  /** Shown in progress lines, e.g. `review lane fix-login at bbbb chunk 1/2`. */
  readonly label: string;
  /** Time left for this process; zero or less reports a timeout without spawning. */
  readonly timeoutMs: number;
  readonly progressMs?: number;
  /** Progress sink; defaults to one stderr line per tick. Tests collect these instead of capturing stderr. */
  readonly onProgress?: (line: string) => void;
  readonly now?: () => number;
};

/** The last VERDICT line a reviewer printed, ignoring anything else it said. */
export function reviewVerdict(stdout: string): ReviewVerdict | undefined {
  const last = [...stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)].at(-1);
  return last?.[1] as ReviewVerdict | undefined;
}

/** `DORI_REVIEW_TIMEOUT_MS` when set to a positive number, else the 10-minute default. */
export function reviewTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env["DORI_REVIEW_TIMEOUT_MS"]);
  return Number.isFinite(ms) && ms >= 1 ? ms : REVIEW_TIMEOUT_MS;
}

const append = (log: string, text: string): void => {
  try {
    appendFileSync(log, text);
  } catch {
    // The log is diagnostic only; the receipt still carries the captured tail.
  }
};

/**
 * Runs one reviewer and returns its exit or timeout. Output is appended to `log` as it arrives, and the same text is
 * kept in memory so a killed process still leaves a diagnosable tail.
 */
export async function runReviewer(run: ReviewerRun): Promise<ReviewOutcome> {
  const now = run.now ?? Date.now;
  const started = now();
  const progressMs = run.progressMs ?? REVIEW_PROGRESS_MS;
  const progress = run.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  let stdout = "";
  let stderr = "";
  let proc: { kill(): void } | undefined;
  let timedOut = false;
  let fireTimeout: (() => void) | undefined;
  const timedOutAt = new Promise<void>((resolve) => {
    fireTimeout = resolve;
  });
  if (run.timeoutMs < 1) return { kind: "timeout", stdout, stderr };
  const deadline = setTimeout(() => {
    timedOut = true;
    try {
      proc?.kill();
    } catch {}
    fireTimeout?.();
  }, run.timeoutMs);
  const beat = setInterval(
    () => {
      const seconds = Math.round((now() - started) / 1000);
      progress(
        `dori: ${run.label} still running after ${seconds}s (${stdout.length + stderr.length} B captured; log ${run.log})`,
      );
    },
    Math.max(1, progressMs),
  );
  beat.unref();
  const pending = run.exec(run.cmd, run.argv, {
    onSpawn: (p) => {
      proc = p;
      if (timedOut) {
        try {
          p.kill();
        } catch {}
      }
    },
    onStdout: (chunk) => {
      stdout += chunk;
      append(run.log, chunk);
    },
    onStderr: (chunk) => {
      stderr += chunk;
      append(run.log, `\n[stderr] ${chunk}`);
    },
  });
  // A timed-out process may still reject later; that is already reported as the timeout.
  pending.catch(() => {});
  const outcome = await Promise.race([
    pending.then((res) => ({ kind: "exit" as const, res })),
    timedOutAt.then(() => ({ kind: "timeout" as const })),
  ]).finally(() => {
    clearTimeout(deadline);
    clearInterval(beat);
  });
  if (outcome.kind === "exit" && !timedOut) return { kind: "exit", ...outcome.res };
  // The kill may not have reaped the process yet; one short grace captures its exit code when it is there.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    pending.then(
      (res) => res,
      () => undefined,
    ),
    new Promise<undefined>((resolve) => {
      graceTimer = setTimeout(() => resolve(undefined), KILL_GRACE_MS);
    }),
  ]);
  clearTimeout(graceTimer);
  return { kind: "timeout", stdout, stderr, ...(settled === undefined ? {} : { code: settled.code }) };
}
