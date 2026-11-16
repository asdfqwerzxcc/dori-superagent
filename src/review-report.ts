// Receipt summaries for a lane review: the digest names every reviewed chunk and its model, a retry names the attempt
// that failed before the fallback ran, and a re-split note names the chunk that returned nothing and its sub-chunks.

import type { DiffChunk } from "./review-chunks.ts";
import type { ReviewOutcome, ReviewVerdict } from "./review-run.ts";

export type LaneRun = {
  readonly label: string;
  readonly text: string;
  readonly chunk?: DiffChunk;
  readonly chunkTotal?: number;
  readonly resplit?: true;
};

export type LaneResult = {
  readonly run: LaneRun;
  readonly argv: readonly string[];
  readonly outcome: ReviewOutcome;
  readonly verdict?: ReviewVerdict;
  readonly model?: string;
  retried?: string;
  retryDiagnostic?: string;
};

const tail = (text: string): string => (text.trim() === "" ? "(empty)" : text.trim().slice(-1200));

const exitLine = (outcome: ReviewOutcome): string =>
  outcome.kind === "timeout"
    ? `timed out${outcome.code === undefined ? " (killed)" : ` (killed, exit ${outcome.code})`}`
    : `exit ${outcome.code}`;

export const failed = (r: LaneResult): boolean => {
  if (r.verdict === undefined) return true;
  return r.outcome.kind === "exit" && r.outcome.code !== 0;
};

export const failureKind = (r: LaneResult): string =>
  r.outcome.kind === "timeout"
    ? "timed out"
    : r.outcome.stdout.trim() === ""
      ? "empty output"
      : r.outcome.code !== 0
        ? `exit ${r.outcome.code}`
        : "no verdict";

const detail = (r: LaneResult): string =>
  `${r.run.label}${r.model === undefined ? "" : ` [${r.model}]`}: ${exitLine(r.outcome)}\nstderr:\n${tail(r.outcome.stderr)}\nstdout:\n${tail(r.outcome.stdout)}`;

const state = (r: LaneResult): string =>
  r.verdict ??
  (r.outcome.kind === "timeout" ? "timed out" : r.outcome.stdout.trim() === "" ? "no output" : "no verdict");

const digest = (results: readonly LaneResult[]): string =>
  `chunks: ${results
    .map((r, i) => {
      const chunk = r.run.chunk;
      if (chunk === undefined) return "";
      return `${i + 1}/${results.length} [${chunk.label ?? chunk.paths.join(", ")}] ${chunk.bytes} B/${
        chunk.lines
      } changed -> ${state(r)}${r.model === undefined ? "" : ` (${r.model})`}`;
    })
    .filter((line) => line !== "")
    .join("; ")}`;

const retryNote = (r: LaneResult): string =>
  r.retried === undefined
    ? ""
    : `--- retry ${r.run.label}: primary ${r.retried}; retried with ${r.model ?? "fallback"}${
        r.retryDiagnostic === undefined ? "" : `; primary diagnostic ${r.retryDiagnostic}`
      }\n`;

const hasChunks = (results: readonly LaneResult[]): boolean => results.some((r) => r.run.chunk !== undefined);

export const failureSummary = (results: readonly LaneResult[], diag: string, notes: readonly string[] = []): string =>
  [
    ...(hasChunks(results) ? [digest(results)] : []),
    ...notes,
    ...results.map((r) => `${retryNote(r)}--- ${detail(r)}`),
    `diagnostic: ${diag}`,
  ]
    .join("\n")
    .slice(0, 4000);

export const successSummary = (results: readonly LaneResult[], notes: readonly string[] = []): string => {
  const retryNotes = results.map(retryNote).join("");
  const killNotes = results
    .filter((r) => r.outcome.kind === "timeout")
    .map((r) => `--- ${r.run.label}: verdict printed; killed after ${r.outcome.durationMs} ms\n`)
    .join("");
  const head = [...(hasChunks(results) ? [digest(results)] : []), ...notes].join("\n");
  const body = results
    .map((r) => r.outcome.stdout.trim())
    .filter((s) => s !== "")
    .join("\n");
  return hasChunks(results)
    ? `${head}\n${killNotes}${retryNotes}${body}`.slice(0, 4000)
    : `${head}${killNotes}${retryNotes}${body}`.slice(-4000);
};
