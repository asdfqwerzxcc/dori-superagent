// Progress rows and the receipt lock for a chunked lane review: every planned chunk with its state, kept current in
// the receipt so a hung job still says what it managed to review, and one writer at a time per lane and tip.

import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { writeJson } from "./json-file.ts";
import { partialSummary, type LaneRun } from "./review-report.ts";
import type { LaneChunkReceipt, LaneChunkState, LaneReceipt } from "./store-types.ts";

export type ProgressUnit = {
  run: LaneRun;
  state: LaneChunkState;
  model?: string;
  durationMs?: number;
  reused?: true;
  note?: string;
};

/** `undefined` clears an optional field, which exactOptionalPropertyTypes refuses in a plain Partial. */
export type ProgressPatch = {
  state?: LaneChunkState;
  model?: string | undefined;
  durationMs?: number;
  reused?: true;
  note?: string | undefined;
};

export const progressUnits = (runs: readonly LaneRun[]): ProgressUnit[] =>
  runs.map((run) => ({ run, state: "pending" }));

export const unitOf = (units: readonly ProgressUnit[], run: LaneRun): ProgressUnit | undefined =>
  units.find((unit) => unit.run === run);

export const updateUnit = (units: readonly ProgressUnit[], run: LaneRun, patch: ProgressPatch): void => {
  const unit = unitOf(units, run);
  if (unit !== undefined) Object.assign(unit, patch);
};

export const unitRow = (unit: ProgressUnit): LaneChunkReceipt => {
  const chunk = unit.run.chunk;
  const head = unit.run.parent
    ? `${unit.run.parent.index}/${unit.run.parent.total}`
    : chunk === undefined
      ? ""
      : `${chunk.index}/${unit.run.chunkTotal ?? "?"}`;
  return {
    label: chunk === undefined ? unit.run.label : `${head} [${chunk.label ?? chunk.paths.join(", ")}]`,
    paths: chunk?.paths ?? [],
    bytes: chunk?.bytes ?? 0,
    lines: chunk?.lines ?? 0,
    state: unit.state,
    ...(unit.model === undefined ? {} : { model: unit.model }),
    ...(unit.durationMs === undefined ? {} : { durationMs: unit.durationMs }),
    ...(unit.reused === true ? { reused: true as const } : {}),
    ...(unit.note === undefined ? {} : { note: unit.note }),
  };
};

export const chunkRows = (units: readonly ProgressUnit[]): LaneChunkReceipt[] => units.map(unitRow);

/** Everything still waiting or running after a stop is `not run`, with the reason the lead needs. */
export const markNotRun = (units: readonly ProgressUnit[], note: string): void => {
  for (const unit of units) {
    if (unit.state !== "pending" && unit.state !== "running") continue;
    unit.state = "not run";
    unit.note = note;
  }
};

export const progressPath = (root: string, key: string, tip: string): string =>
  join(root, "state", "reviews", `${key}@${tip}.progress.json`);

/** The per-lane+tip receipt lock: an atomically created directory a dead writer cannot hold past the TTL. */
export const receiptLockPath = (root: string, key: string, tip: string): string =>
  join(root, "state", "reviews", `${key}@${tip}.receipt.lock`);

/** A lock older than this is taken over; the critical section under it is a small file read and write. */
export const RECEIPT_LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_RETRY_MS = 10;

/** Test seam: `afterRead` widens the read-modify-write window, `onLockWait` observes a contending writer. */
export type ReceiptWriteHooks = {
  readonly afterRead?: () => void | Promise<void>;
  readonly onLockWait?: () => void;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withReceiptLock<T>(
  root: string,
  key: string,
  tip: string,
  fn: () => T | Promise<T>,
  hooks?: ReceiptWriteHooks,
): Promise<T> {
  const lock = receiptLockPath(root, key, tip);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      hooks?.onLockWait?.();
      try {
        if (Date.now() - statSync(lock).mtimeMs > RECEIPT_LOCK_TTL_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`receipt lock for ${key}@${tip} held longer than ${LOCK_WAIT_MS} ms`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Removes the sidecar under the receipt lock, so a clear and a concurrent progress write cannot interleave. */
export async function clearProgress(d: Deps, key: string, tip: string): Promise<void> {
  await withReceiptLock(d.store.root, key, tip, () => {
    rmSync(progressPath(d.store.root, key, tip), { force: true });
  });
}

/**
 * Writes the live receipt: `review_partial` with every planned chunk and its state. The decision is made on the
 * receipt on disk at write time under the receipt lock: when a CLEAR or BLOCK is already there, the progress goes to
 * the sidecar, so a concurrent or interrupted re-review cannot erase a valid answer.
 */
export async function savePartialReceipt(args: {
  readonly d: Deps;
  readonly key: string;
  readonly tip: string;
  readonly base: string;
  readonly brief: string;
  readonly reviewer: string;
  readonly units: readonly ProgressUnit[];
}): Promise<void> {
  const rows = chunkRows(args.units);
  const partial: LaneReceipt = {
    lane: args.key,
    verdict: "review_partial",
    base: args.base,
    tip: args.tip,
    brief: args.brief,
    reviewer: args.reviewer,
    at: args.d.now(),
    summary: partialSummary(rows),
    chunks: rows,
  };
  await withReceiptLock(args.d.store.root, args.key, args.tip, () => {
    const current = args.d.store.laneReceipt(args.key, args.tip);
    if (current?.verdict === "CLEAR" || current?.verdict === "BLOCK")
      writeJson(progressPath(args.d.store.root, args.key, args.tip), partial);
    else args.d.store.saveLaneReceipt(partial);
  });
}

/** Where a finished review wrote its verdict: the canonical receipt, or the sidecar when it could not improve one. */
export type FinalSave =
  | { readonly where: "canonical" }
  | { readonly where: "sidecar"; readonly kept: "CLEAR" | "BLOCK" };

/**
 * Saves the final verdict under the lock without downgrading a completed one. BLOCK wins over CLEAR at the same tip;
 * a CLEAR never replaces a BLOCK, and a failure never replaces either (both go to the sidecar), so a lane clears a
 * BLOCK only by moving the tip. A job that produces a stronger verdict may replace the canonical one.
 */
export async function saveFinalReceipt(
  args: {
    readonly d: Deps;
    readonly key: string;
    readonly tip: string;
    readonly receipt: LaneReceipt;
  },
  hooks?: ReceiptWriteHooks,
): Promise<FinalSave> {
  const saved = await withReceiptLock(
    args.d.store.root,
    args.key,
    args.tip,
    async () => {
      const current = args.d.store.laneReceipt(args.key, args.tip);
      await hooks?.afterRead?.();
      const completed = current?.verdict === "CLEAR" || current?.verdict === "BLOCK";
      const newCompleted = args.receipt.verdict === "CLEAR" || args.receipt.verdict === "BLOCK";
      const blockWins = current?.verdict === "BLOCK" && args.receipt.verdict === "CLEAR";
      if ((completed && !newCompleted) || blockWins) {
        writeJson(progressPath(args.d.store.root, args.key, args.tip), args.receipt);
        return { where: "sidecar", kept: current!.verdict as "CLEAR" | "BLOCK" } as const;
      }
      args.d.store.saveLaneReceipt(args.receipt);
      return { where: "canonical" } as const;
    },
    hooks,
  );
  if (saved.where === "canonical") await clearProgress(args.d, args.key, args.tip);
  return saved;
}
