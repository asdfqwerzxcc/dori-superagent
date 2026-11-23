// Progress rows for a chunked lane review: every planned chunk with its state, kept current in the receipt so a hung
// job still says what it managed to review and what it never reached.

import { rmSync } from "node:fs";
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

export const clearProgress = (d: Deps, key: string, tip: string): void => {
  rmSync(progressPath(d.store.root, key, tip), { force: true });
};

/**
 * Writes the live receipt: `review_partial` with every planned chunk and its state. A tip that already has a CLEAR or
 * BLOCK receipt keeps it, and the progress goes to the sidecar instead, so a killed re-review cannot erase a valid
 * answer.
 */
export function savePartialReceipt(args: {
  readonly d: Deps;
  readonly key: string;
  readonly tip: string;
  readonly base: string;
  readonly brief: string;
  readonly reviewer: string;
  readonly prior: LaneReceipt | undefined;
  readonly units: readonly ProgressUnit[];
}): void {
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
  if (args.prior?.verdict === "CLEAR" || args.prior?.verdict === "BLOCK")
    writeJson(progressPath(args.d.store.root, args.key, args.tip), partial);
  else args.d.store.saveLaneReceipt(partial);
}
