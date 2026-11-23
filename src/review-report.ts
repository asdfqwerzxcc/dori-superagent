// Receipt summaries for a lane review: the digest names every reviewed chunk and its model, a retry names the attempt
// that failed before the fallback ran, and a re-split note names the chunk that returned nothing and its sub-chunks.

import type { DiffChunk } from "./review-chunks.ts";
import type { ReviewOutcome, ReviewVerdict } from "./review-run.ts";
import type { LaneChunkReceipt, LaneChunkState } from "./store-types.ts";

export type LaneRun = {
  readonly label: string;
  readonly text: string;
  readonly chunk?: DiffChunk;
  readonly chunkTotal?: number;
  readonly resplit?: true;
  /** The top-level chunk a re-split sub-chunk belongs to, so its receipt row names the chunk it came from. */
  readonly parent?: { readonly index: number; readonly total: number };
};

export type LaneResult = {
  readonly run: LaneRun;
  readonly argv: readonly string[];
  readonly outcome: ReviewOutcome;
  readonly verdict?: ReviewVerdict;
  readonly model?: string;
  retried?: string;
  retryDiagnostic?: string;
  /** True for a chunk answered in an earlier attempt and read back from the checkpoint. */
  reused?: true;
};

const tail = (text: string): string => (text.trim() === "" ? "(empty)" : text.trim().slice(-1200));

const exitLine = (outcome: ReviewOutcome): string =>
  outcome.kind === "timeout"
    ? `timed out${outcome.code === undefined ? " (killed)" : ` (killed, exit ${outcome.code})`}`
    : outcome.kind === "error"
      ? `threw: ${outcome.message}`
      : `exit ${outcome.code}`;

/** A reviewer run that never produced a process is a failure like any other, never a pass. */
export const failed = (r: LaneResult): boolean =>
  r.outcome.kind === "error" || r.verdict === undefined || (r.outcome.kind === "exit" && r.outcome.code !== 0);

export const failureKind = (r: LaneResult): string =>
  r.outcome.kind === "error"
    ? "threw"
    : r.outcome.kind === "timeout"
      ? `timed out after ${r.outcome.durationMs} ms`
      : r.outcome.stdout.trim() === ""
        ? "empty output"
        : r.outcome.code !== 0
          ? `exit ${r.outcome.code}`
          : "no verdict";

const AUTH_FAILURE = /no api key|api[_-]?key|not logged in|unauthori[sz]ed|authenticat|\b40[13]\b/i;

/** The stderr line that explains a failure: the auth line when there is one, else the first non-empty line. */
const stderrReason = (stderr: string): string => {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.find((l) => AUTH_FAILURE.test(l)) ?? lines[0] ?? "";
};

/** One line naming why an attempt failed, quoted by a diagnostic's `cause` and by the retry note. */
export const failureCause = (r: LaneResult): string => {
  if (r.outcome.kind === "error") return `threw: ${r.outcome.message}`;
  if (r.outcome.kind === "timeout") return `timed out after ${r.outcome.durationMs} ms`;
  const line = stderrReason(r.outcome.stderr);
  if (r.outcome.code !== 0) return `exit ${r.outcome.code}${line === "" ? "" : `: ${line}`}`;
  return r.outcome.stdout.trim() === "" ? "empty output" : "no verdict";
};

/**
 * A primary that could not be started or was refused by the provider (a missing key, a rejected one) fails the same way
 * on every chunk, so the rest of the job goes straight to the fallback instead of paying for the same failure again.
 */
export const primaryUnusable = (r: LaneResult): boolean =>
  r.outcome.kind === "error" ||
  (r.outcome.kind === "exit" &&
    r.outcome.code !== 0 &&
    (AUTH_FAILURE.test(r.outcome.stderr) || AUTH_FAILURE.test(r.outcome.stdout)));

const detail = (r: LaneResult): string => {
  const stderr = r.outcome.kind === "error" ? r.outcome.message : r.outcome.stderr;
  const stdout = r.outcome.kind === "error" ? "" : r.outcome.stdout;
  return `${r.run.label}${r.model === undefined ? "" : ` [${r.model}]`}: ${exitLine(r.outcome)}\nstderr:\n${tail(stderr)}\nstdout:\n${tail(stdout)}`;
};

/** The one-word state a chunk row carries; a timeout that already printed its verdict counts as answered. */
export const outcomeState = (r: LaneResult): LaneChunkState => {
  if (r.outcome.kind === "error") return "failed";
  if (r.verdict !== undefined && !(r.outcome.kind === "exit" && r.outcome.code !== 0)) return r.verdict;
  if (r.outcome.kind === "timeout") return "timed out";
  if (r.outcome.kind === "exit" && r.outcome.stdout.trim() === "") return "empty";
  return "failed";
};

/** The digest a chunked receipt's summary starts with: every chunk, its size, its state and the model that answered. */
export const chunkDigest = (chunks: readonly LaneChunkReceipt[]): string =>
  `chunks: ${chunks
    .map(
      (c) =>
        `${c.label} ${c.bytes} B/${c.lines} changed -> ${c.state}${c.model === undefined ? "" : ` (${c.model})`}${
          c.reused === true ? " (reused)" : ""
        }${c.note === undefined ? "" : ` [${c.note}]`}`,
    )
    .join("; ")}`;

export const partialSummary = (chunks: readonly LaneChunkReceipt[]): string =>
  `review in progress\n${chunkDigest(chunks)}`.slice(0, 4000);

const retryNote = (r: LaneResult): string =>
  r.retried === undefined
    ? ""
    : r.reused === true
      ? `--- ${r.run.label}: reused ${r.model ?? "fallback"} from the previous attempt${
          r.retryDiagnostic === undefined ? "" : `; primary diagnostic ${r.retryDiagnostic}`
        }\n`
      : `--- retry ${r.run.label}: primary ${r.retried}; retried with ${r.model ?? "fallback"}${
          r.retryDiagnostic === undefined ? "" : `; primary diagnostic ${r.retryDiagnostic}`
        }\n`;

export const failureSummary = (
  results: readonly LaneResult[],
  diag: string,
  notes: readonly string[] = [],
  chunks?: readonly LaneChunkReceipt[],
  diagnostics: readonly { readonly label: string; readonly path: string }[] = [],
): string =>
  [
    ...(chunks === undefined ? [] : [chunkDigest(chunks)]),
    ...notes,
    ...results.map((r) => `${retryNote(r)}--- ${detail(r)}`),
    ...(diagnostics.length > 1 ? diagnostics.map((d) => `diagnostic ${d.label}: ${d.path}`) : []),
    `diagnostic: ${diag}`,
  ]
    .join("\n")
    .slice(0, 4000);

export const successSummary = (
  results: readonly LaneResult[],
  notes: readonly string[] = [],
  chunks?: readonly LaneChunkReceipt[],
): string => {
  const retryNotes = results.map(retryNote).join("");
  const killNotes = results
    .filter((r) => r.outcome.kind === "timeout")
    .map((r) => `--- ${r.run.label}: verdict printed; killed after ${r.outcome.durationMs} ms\n`)
    .join("");
  const head = [...(chunks === undefined ? [] : [chunkDigest(chunks)]), ...notes].join("\n");
  const body = results
    .map((r) => (r.outcome.kind === "error" ? "" : r.outcome.stdout.trim()))
    .filter((s) => s !== "")
    .join("\n");
  return chunks === undefined
    ? `${head}${killNotes}${retryNotes}${body}`.slice(-4000)
    : `${head}\n${killNotes}${retryNotes}${body}`.slice(0, 4000);
};
