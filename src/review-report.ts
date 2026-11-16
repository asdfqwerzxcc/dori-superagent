// Receipt summaries for a lane review: the digest names every chunk and its model, and a retry names the attempt that
// failed before the fallback ran. The same text feeds the receipt and the refusal line.

import type { DiffChunk } from "./review-chunks.ts";
import type { ReviewOutcome, ReviewVerdict } from "./review-run.ts";

export type LaneRun = { readonly label: string; readonly text: string; readonly chunk?: DiffChunk };

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

export const failed = (r: LaneResult): boolean =>
  r.outcome.kind !== "exit" || r.outcome.code !== 0 || r.outcome.stdout.trim() === "" || r.verdict === undefined;

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

const digest = (chunks: readonly DiffChunk[], results: readonly LaneResult[]): string =>
  `chunks: ${chunks
    .map((c, i) => {
      const r = results[i];
      const state =
        r === undefined ? "not run" : (r.verdict ?? (r.outcome.kind === "timeout" ? "timed out" : "no output"));
      return `${c.index}/${chunks.length} [${c.paths.join(", ")}] ${c.bytes} B/${c.lines} changed -> ${state}${
        r?.model === undefined ? "" : ` (${r.model})`
      }`;
    })
    .join("; ")}`;

const retryNote = (r: LaneResult): string =>
  r.retried === undefined
    ? ""
    : `--- retry ${r.run.label}: primary ${r.retried}; retried with ${r.model ?? "fallback"}${
        r.retryDiagnostic === undefined ? "" : `; primary diagnostic ${r.retryDiagnostic}`
      }\n`;

export const failureSummary = (
  chunks: readonly DiffChunk[] | undefined,
  results: readonly LaneResult[],
  diag: string,
): string =>
  [
    ...(chunks === undefined ? [] : [digest(chunks, results)]),
    ...results.map((r) => `${retryNote(r)}--- ${detail(r)}`),
    `diagnostic: ${diag}`,
  ]
    .join("\n")
    .slice(0, 4000);

export const successSummary = (chunks: readonly DiffChunk[] | undefined, results: readonly LaneResult[]): string => {
  const notes = results.map(retryNote).join("");
  return chunks === undefined
    ? `${notes}${results.at(-1)?.outcome.stdout.trim() ?? ""}`.slice(-4000)
    : `${digest(chunks, results)}\n${notes}${results
        .map((r) => `--- ${r.run.label}\n${r.outcome.stdout.trim()}`)
        .join("\n")}`.slice(0, 4000);
};
