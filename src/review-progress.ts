// Progress rows and the fenced receipt writes for a chunked lane review: every planned chunk with its state, and a
// canonical verdict that an older lock epoch can never overwrite.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { readJson, writeJson } from "./json-file.ts";
import { withReceiptLock, type ReceiptWriteHooks } from "./receipt-lock.ts";
import { partialSummary, type LaneRun } from "./review-report.ts";
import type { LaneChunkReceipt, LaneChunkState, LaneReceipt, LaneVerdict } from "./store-types.ts";

export { RECEIPT_LOCK_TTL_MS, receiptLockPath, type ReceiptWriteHooks } from "./receipt-lock.ts";

export type ProgressUnit = {
  run: LaneRun;
  state: LaneChunkState;
  model?: string;
  durationMs?: number;
  reused?: true;
  primaryDown?: true;
  note?: string;
};

/** `undefined` clears an optional field, which exactOptionalPropertyTypes refuses in a plain Partial. */
export type ProgressPatch = {
  state?: LaneChunkState;
  model?: string | undefined;
  durationMs?: number;
  reused?: true;
  primaryDown?: true;
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
    ...(unit.primaryDown === true ? { primaryDown: true as const } : {}),
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

const readSidecar = (path: string): LaneReceipt | undefined => {
  try {
    return readJson<LaneReceipt>(path);
  } catch {
    return undefined;
  }
};

/** The sidecar is deleted under the lock only when its `writerAt` and the canonical's are not newer than the fence. */
export async function clearProgress(d: Deps, key: string, tip: string, writerAt?: number): Promise<void> {
  await withReceiptLock(d.store.root, key, tip, (lock) => {
    const fence = writerAt ?? lock.acquiredAt;
    const path = progressPath(d.store.root, key, tip);
    const sidecar = readSidecar(path);
    if (sidecar?.writerAt !== undefined && sidecar.writerAt > fence) return;
    const current = d.store.laneReceipt(key, tip);
    if (current?.writerAt !== undefined && current.writerAt > fence) return;
    rmSync(path, { force: true });
  });
}

/**
 * Writes the live receipt under the lock: `review_partial` with every planned chunk. A newer canonical epoch or a
 * completed CLEAR/BLOCK sends the partial to the sidecar; otherwise it is the canonical receipt, stamped with this
 * writer's `writerAt`.
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
  await withReceiptLock(args.d.store.root, args.key, args.tip, (lock) => {
    const receipt: LaneReceipt = { ...partial, writerAt: lock.acquiredAt };
    const current = args.d.store.laneReceipt(args.key, args.tip);
    const preempted = current?.writerAt !== undefined && current.writerAt > lock.acquiredAt;
    if (preempted || current?.verdict === "CLEAR" || current?.verdict === "BLOCK")
      writeJson(progressPath(args.d.store.root, args.key, args.tip), receipt);
    else args.d.store.saveLaneReceipt(receipt);
  });
}

/** Where a finished review wrote its verdict: the canonical receipt, or the sidecar when it could not improve one. */
export type FinalSave = { readonly where: "canonical" } | { readonly where: "sidecar"; readonly kept: LaneVerdict };

/**
 * Saves the final verdict under the lock without downgrading a completed one. The canonical is re-read at write time
 * under the lock: an older epoch writes only the sidecar, BLOCK wins over CLEAR at the same tip, and a failure never
 * replaces a completed verdict.
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
  const result = await withReceiptLock(
    args.d.store.root,
    args.key,
    args.tip,
    async (lock) => {
      await hooks?.beforeWrite?.();
      const current = args.d.store.laneReceipt(args.key, args.tip);
      const receipt: LaneReceipt = { ...args.receipt, writerAt: lock.acquiredAt };
      const preempted = current?.writerAt !== undefined && current.writerAt > lock.acquiredAt;
      const completed = current?.verdict === "CLEAR" || current?.verdict === "BLOCK";
      const newCompleted = receipt.verdict === "CLEAR" || receipt.verdict === "BLOCK";
      const blockWins = current?.verdict === "BLOCK" && receipt.verdict === "CLEAR";
      if (preempted || (completed && !newCompleted) || blockWins) {
        writeJson(progressPath(args.d.store.root, args.key, args.tip), receipt);
        return {
          save: { where: "sidecar", kept: current?.verdict ?? "review_partial" } as const,
          writerAt: lock.acquiredAt,
        };
      }
      args.d.store.saveLaneReceipt(receipt);
      return { save: { where: "canonical" } as const, writerAt: lock.acquiredAt };
    },
    hooks,
  );
  if (result.save.where === "canonical") await clearProgress(args.d, args.key, args.tip, result.writerAt);
  return result.save;
}
