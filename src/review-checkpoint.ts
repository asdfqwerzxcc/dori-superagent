// Chunk-level progress for one lane review, kept across attempts: a chunk that already answered is never paid for
// twice. The file is keyed by lane and tip, so a new commit starts clean, and by reviewer, so `--model` changes the job.

import { createHash } from "node:crypto";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./json-file.ts";
import { failed, type LaneResult, type LaneRun } from "./review-report.ts";
import type { ReviewVerdict } from "./review-run.ts";

/** One chunk that answered in an earlier attempt: its exact text (by hash), verdict and the reviewer that gave it. */
export type CheckpointChunk = {
  readonly hash: string;
  readonly label: string;
  readonly verdict: ReviewVerdict;
  readonly model?: string;
  readonly durationMs: number;
  readonly at: number;
};

/** `reviewer` is the reviewer command a retry must use for these answers to count (model, or a hook argv). */
export type ReviewCheckpoint = {
  readonly lane: string;
  readonly tip: string;
  readonly base: string;
  readonly reviewer: string;
  readonly chunks: readonly CheckpointChunk[];
};

/** A chunk's identity in a checkpoint: its rendered prompt, so a re-plan, a prompt change or a different tip can never
 * match an earlier answer by accident. */
export const chunkHash = (text: string): string => createHash("sha256").update(text).digest("hex");

export const checkpointPath = (root: string, key: string, tip: string): string =>
  join(root, "state", "reviews", `${key}@${tip}.chunks.json`);

const isVerdict = (v: unknown): v is ReviewVerdict => v === "CLEAR" || v === "BLOCK";

const validChunk = (c: Partial<CheckpointChunk>): c is CheckpointChunk =>
  typeof c.hash === "string" &&
  c.hash.length > 0 &&
  typeof c.label === "string" &&
  isVerdict(c.verdict) &&
  (c.model === undefined || typeof c.model === "string") &&
  typeof c.durationMs === "number" &&
  Number.isFinite(c.durationMs) &&
  typeof c.at === "number" &&
  Number.isFinite(c.at);

/**
 * The checkpoint for exactly this lane, tip, base and reviewer, or undefined. Anything else in the file (another
 * tip, another model, a hand-edited entry) is discarded: a stored answer only counts for the diff it reviewed.
 */
export function readCheckpoint(
  root: string,
  key: string,
  tip: string,
  base: string,
  reviewer: string,
): ReviewCheckpoint | undefined {
  let raw: ReviewCheckpoint;
  try {
    const parsed = readJson<ReviewCheckpoint>(checkpointPath(root, key, tip));
    if (parsed === undefined) return undefined;
    raw = parsed;
  } catch {
    return undefined;
  }
  if (raw.lane !== key || raw.tip !== tip || raw.base !== base || raw.reviewer !== reviewer) return undefined;
  if (!Array.isArray(raw.chunks)) return undefined;
  return { ...raw, chunks: raw.chunks.filter(validChunk) };
}

/** Writes the checkpoint atomically, newest answer per chunk hash winning; an empty list leaves no file behind. */
export function saveCheckpoint(root: string, checkpoint: ReviewCheckpoint): void {
  const latest = new Map<string, CheckpointChunk>();
  for (const chunk of checkpoint.chunks) latest.set(chunk.hash, chunk);
  const chunks = [...latest.values()];
  const path = checkpointPath(root, checkpoint.lane, checkpoint.tip);
  if (chunks.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeJson(path, { ...checkpoint, chunks });
}

export const clearCheckpoint = (root: string, key: string, tip: string): void => {
  rmSync(checkpointPath(root, key, tip), { force: true });
};

/** Drops checkpoints a lane left at other tips; best effort, since the current one is the only useful record. */
export function pruneCheckpoints(root: string, key: string, keepTip: string): void {
  const dir = join(root, "state", "reviews");
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const file = new RegExp(`^${escaped}@[0-9a-f]{7,64}\\.chunks\\.json$`);
  try {
    for (const name of readdirSync(dir)) {
      if (!file.test(name)) continue;
      if (name === `${key}@${keepTip}.chunks.json`) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    // A missing reviews directory just means there is nothing to prune.
  }
}

/** The two operations a retry needs: find an answered chunk, and record a new answer. */
export type ReviewResume = {
  reuse(run: LaneRun): LaneResult | undefined;
  remember(run: LaneRun, result: LaneResult, label: string): void;
};

/**
 * Loads the checkpoint for this lane, tip, base and reviewer and prunes checkpoints a lane left at other tips. A
 * reused answer is shaped like a completed run (exit 0, its verdict, its duration), so the caller treats it exactly
 * like an answer from this attempt without spawning anything.
 */
export function loadResume(args: {
  readonly root: string;
  readonly lane: string;
  readonly tip: string;
  readonly base: string;
  readonly reviewer: string;
  readonly now: () => number;
}): ReviewResume {
  pruneCheckpoints(args.root, args.lane, args.tip);
  const cached = readCheckpoint(args.root, args.lane, args.tip, args.base, args.reviewer);
  let chunks: CheckpointChunk[] = cached === undefined ? [] : [...cached.chunks];
  return {
    reuse: (run) => {
      const hit = chunks.find((c) => c.hash === chunkHash(run.text));
      if (hit === undefined) return undefined;
      return {
        run,
        argv: [],
        outcome: { kind: "exit", code: 0, stdout: "", stderr: "", durationMs: hit.durationMs },
        verdict: hit.verdict,
        ...(hit.model === undefined ? {} : { model: hit.model }),
        reused: true,
      };
    },
    remember: (run, result, label) => {
      if (run.chunk === undefined || result.verdict === undefined || failed(result)) return;
      chunks = [
        ...chunks.filter((c) => c.hash !== chunkHash(run.text)),
        {
          hash: chunkHash(run.text),
          label,
          verdict: result.verdict,
          ...(result.model === undefined ? {} : { model: result.model }),
          durationMs: result.outcome.durationMs,
          at: args.now(),
        },
      ];
      saveCheckpoint(args.root, {
        lane: args.lane,
        tip: args.tip,
        base: args.base,
        reviewer: args.reviewer,
        chunks,
      });
    },
  };
}
