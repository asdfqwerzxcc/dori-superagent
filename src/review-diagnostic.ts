// The JSON diagnostic for a failed reviewer run: the facts the old zero-byte noverdict files were missing, including
// the model that actually ran, the exit code, the duration, both output tails, and the argv with the prompt elided.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewOutcome } from "./review-run.ts";

export type ReviewDiagnostic = {
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly argv: readonly string[] | null;
  readonly model: string | null;
  readonly chunk?: string;
};

const ELIDE = 512;
const MAX_TAIL = 4000;

const elide = (arg: string): string => (arg.length > ELIDE ? `<${arg.length} chars>` : arg);
const tail = (text: string): string => text.split(/\r?\n/).slice(-200).join("\n").slice(-MAX_TAIL);

export function reviewDiagnostic(
  argv: readonly string[] | null,
  outcome: ReviewOutcome,
  model: string | null,
  chunk?: string,
): ReviewDiagnostic {
  return {
    exitCode: outcome.kind === "exit" ? outcome.code : outcome.kind === "timeout" ? (outcome.code ?? null) : null,
    durationMs: outcome.durationMs,
    stdoutTail: tail(outcome.kind === "error" ? "" : outcome.stdout),
    stderrTail: tail(outcome.kind === "error" ? outcome.message : outcome.stderr),
    argv: argv === null ? null : argv.map(elide),
    model,
    ...(chunk === undefined ? {} : { chunk }),
  };
}

/** Writes the diagnostic as JSON under `receipts/` and returns its path. */
export function writeReviewDiagnostic(root: string, key: string, tip: string, diagnostic: ReviewDiagnostic): string {
  const path = join(root, "receipts", `lane_${key}@${tip}-${randomUUID()}.diagnostic.json`);
  writeFileSync(path, `${JSON.stringify(diagnostic, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

/** A compact rendering for a refusal line; the full tails stay in the file. */
export function diagnosticLine(diagnostic: ReviewDiagnostic): string {
  return JSON.stringify({
    ...diagnostic,
    stdoutTail: diagnostic.stdoutTail.slice(-400),
    stderrTail: diagnostic.stderrTail.slice(-400),
  });
}
