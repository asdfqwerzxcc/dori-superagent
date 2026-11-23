// A reviewer attempt that cannot throw: an exec rejection (a missing agent binary, for example) becomes that chunk's
// failed result with the error text, so the job records it and goes on to the next chunk. The chunked retry rules live
// here too: a primary that cannot run is retried on the fallback, and a known-dead primary is skipped for later chunks.

import type { RetryFacts, ReviewDiagnostic } from "./review-diagnostic.ts";
import { failed, failureCause, failureKind, type LaneResult, type LaneRun, primaryUnusable } from "./review-report.ts";

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const attemptSafely = async (
  attempt: () => Promise<LaneResult>,
  run: LaneRun,
  model: string | undefined,
): Promise<LaneResult> => {
  const started = Date.now();
  try {
    return await attempt();
  } catch (e) {
    return {
      run,
      argv: [],
      outcome: { kind: "error", message: messageOf(e), durationMs: Date.now() - started },
      ...(model === undefined ? {} : { model }),
    };
  }
};

/** The primary's first failure that names a dead provider; every later chunk quotes this cause and diagnostic. */
export type PrimaryDown = { readonly cause: string; readonly diagnostic: string };

export type ChunkAttemptResult =
  | { readonly kind: "resplit"; readonly result: LaneResult }
  | {
      readonly kind: "done";
      readonly result: LaneResult;
      readonly skippedPrimary: boolean;
      readonly retriedOnFallback: boolean;
      readonly primaryDown?: PrimaryDown;
    };

export type ChunkAttemptArgs = {
  readonly run: LaneRun;
  readonly chosen: string | undefined;
  readonly fallback: string | undefined;
  readonly deadline: number;
  readonly attemptMs: number;
  readonly attempt: (run: LaneRun, model: string | undefined, limitMs: number) => Promise<LaneResult>;
  readonly diagnose: (result: LaneResult, retry?: RetryFacts) => { diagnostic: ReviewDiagnostic; path: string };
  /** True for a clean empty answer that the caller can still split; the helper hands it back before any retry. */
  readonly canResplit: (result: LaneResult) => boolean;
};

/**
 * One chunk's attempts: the fallback alone when the primary is already down, else the primary and, on a failure, one
 * immediate retry on the fallback inside the same window. A clean empty answer is handed back so the caller can
 * re-split the chunk instead of retrying the same oversized prompt.
 */
export async function attemptChunk(args: ChunkAttemptArgs, down: PrimaryDown | undefined): Promise<ChunkAttemptResult> {
  const slice = (): number => Math.max(1, Math.min(args.attemptMs, args.deadline - Date.now()));
  const { fallback } = args;
  if (down !== undefined && fallback !== undefined && fallback !== args.chosen) {
    const result = await attemptSafely(() => args.attempt(args.run, fallback, slice()), args.run, fallback);
    result.retried = `skipped: ${down.cause}`;
    result.retryDiagnostic = down.diagnostic;
    return { kind: "done", result, skippedPrimary: true, retriedOnFallback: true };
  }
  let result = await attemptSafely(() => args.attempt(args.run, args.chosen, slice()), args.run, args.chosen);
  if (args.canResplit(result)) return { kind: "resplit", result };
  if (failed(result) && fallback !== undefined && fallback !== args.chosen && args.deadline > Date.now()) {
    const primary = result;
    const primaryDiag = args.diagnose(primary, { retried: true, retryModel: fallback });
    const primaryDown = primaryUnusable(primary)
      ? { cause: failureCause(primary), diagnostic: primaryDiag.path }
      : undefined;
    const remaining = Math.max(1, Math.min(args.attemptMs, args.deadline - Date.now()));
    result = await attemptSafely(() => args.attempt(args.run, fallback, remaining), args.run, fallback);
    result.retried = `${primary.model ?? "default"} ${failureKind(primary)}`;
    result.retryDiagnostic = primaryDiag.path;
    return {
      kind: "done",
      result,
      skippedPrimary: false,
      retriedOnFallback: true,
      ...(primaryDown === undefined ? {} : { primaryDown }),
    };
  }
  return { kind: "done", result, skippedPrimary: false, retriedOnFallback: false };
}
