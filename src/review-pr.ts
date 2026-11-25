// The built-in PR reviewer: one fresh non-interactive reviewer pinned to the PR head, its verdict written as a
// receipt. Kept out of the merge gate so the gate stays a rule module and this stays the process that feeds it.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gh, headSha, parsePr } from "./gate.ts";
import { prompt, type Deps } from "./harness.ts";
import { loadHooks, loadReviewSettings, substitute } from "./hooks.ts";
import { laneRepo } from "./lane-repo.ts";
import { savedDiffBase } from "./lane-review-binding.ts";
import type { ExecOptions } from "./runtime/exec.ts";
import { CEILING_VARS } from "./worker-limits.ts";

/** Windows caps one CreateProcess command line near 32,767 chars; leave room for the executable and its flags. */
const HOOK_ARGV_LIMIT = 30_000;
/** The full reviewer output saved beside the receipt; findings at the head must survive a huge transcript. */
const REVIEW_TEXT_CAP = 65_536;
const SUMMARY_SIDE = 2_000;
/** A lane brief is inlined because the reviewer has no tools; cap it so a huge brief cannot crowd out the diff. */
const BRIEF_CAP = 12_000;
const LANE_BRANCH_RE = /^lane\/([a-z][a-z0-9-]{1,40})$/;
const FOOTER_MARK = "## Lane rules (added by dori for lane ";

/** Cap the user brief but keep the lane contract `startLane` appends: the footer is the contract's final copy. */
function capBrief(text: string): string {
  if (text.length <= BRIEF_CAP) return text;
  const at = text.lastIndexOf(FOOTER_MARK);
  if (at < 0) return `${text.slice(0, BRIEF_CAP)}\n... [brief truncated at ${BRIEF_CAP} characters]`;
  const body = text.slice(0, at).trimEnd();
  const footer = text.slice(at);
  const room = Math.max(0, BRIEF_CAP - footer.length);
  const kept =
    body.length <= room ? body : `${body.slice(0, room)}\n... [brief truncated; the lane contract follows unchanged]`;
  return `${kept}\n\n${footer}`;
}

type LaneReview = {
  readonly key: string;
  readonly base: string;
  readonly brief: string;
  readonly diff: string;
  readonly diffPath: string;
  readonly checkout: string;
};

/**
 * A lane PR is reviewed from the saved lane diff and the lane's brief — the artifact and contract that `--attest`
 * binds — instead of the server-rendered PR diff. A PR that is not a lane branch, or whose head has no saved diff,
 * returns undefined and is reviewed as an ordinary PR.
 */
async function laneReview(d: Deps, view: Record<string, unknown>, sha: string): Promise<LaneReview | undefined> {
  const key = LANE_BRANCH_RE.exec(String(view["headRefName"] ?? ""))?.[1];
  if (key === undefined) return undefined;
  const lane = d.store.lane(key);
  if (lane === undefined) return undefined;
  const diffPath = d.store.laneDiffPath(key, sha);
  let diff: string;
  try {
    diff = readFileSync(diffPath, "utf8");
  } catch {
    return undefined;
  }
  let brief: string;
  try {
    brief = readFileSync(lane.brief, "utf8").trim();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`lane ${key}: cannot read its brief at ${lane.brief} (${why}); the reviewer needs the contract`);
  }
  const repo = laneRepo(lane);
  const base = (await savedDiffBase(d, lane, repo, sha)) ?? "unknown";
  return { key, base, brief: capBrief(brief), diff, diffPath, checkout: repo };
}

const argvLength = (argv: readonly string[]): number => argv.reduce((total, part) => total + part.length + 1, 0);
const reviewTextPath = (root: string, pr: string, sha: string): string =>
  join(root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.review.txt`);

/** Head and tail: a long transcript keeps the findings at the top and the final verdict at the bottom. */
const summarizeReview = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_SIDE * 2
    ? trimmed
    : `${trimmed.slice(0, SUMMARY_SIDE)}\n...\n${trimmed.slice(-SUMMARY_SIDE)}`;
};

const capReviewText = (text: string): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= REVIEW_TEXT_CAP) return text;
  const half = Math.floor(REVIEW_TEXT_CAP / 2);
  return `${bytes.subarray(0, half).toString("utf8")}\n...\n${bytes.subarray(bytes.length - half).toString("utf8")}`;
};

/** One chunk of a reviewer's output as it arrives; the background worker records it as progress. */
export type ReviewOutput = { readonly stream: "stdout" | "stderr"; readonly chunk: string };
export type ReviewOptions = {
  readonly onOutput?: (out: ReviewOutput) => void;
  readonly onHead?: (sha: string) => void;
};

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(
  d: Deps,
  prId: string,
  model?: string,
  opts: ReviewOptions = {},
): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  // hooks.reviewCommand replaces the built-in reviewer; it must print a VERDICT line like the built-in one.
  const hook = loadHooks(d.store.root).reviewCommand;
  const sha = await headSha(d, pr);
  opts.onHead?.(sha);
  const view = JSON.parse(
    await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "title,body,headRefName"]),
  );
  const lane = await laneReview(d, view, sha);
  const diff = lane === undefined ? await gh(d, ["pr", "diff", String(pr.number), "--repo", pr.repo]) : "";
  const vars = {
    pr: pr.id,
    repo: pr.repo,
    number: String(pr.number),
    sha,
    title: `${String(view.title ?? "")}\n\n${String(view.body ?? "")}`.trim(),
    diff: lane?.diff ?? diff,
    ...CEILING_VARS,
    ...(lane === undefined
      ? {}
      : {
          key: lane.key,
          base: lane.base,
          tip: sha,
          brief: lane.brief,
          diffPath: lane.diffPath,
          checkout: lane.checkout,
        }),
  };
  const text = prompt(lane === undefined ? "review.md" : "review-lane.md", vars);
  const callbacks =
    opts.onOutput === undefined
      ? undefined
      : {
          onStdout: (chunk: string) => opts.onOutput?.({ stream: "stdout", chunk }),
          onStderr: (chunk: string) => opts.onOutput?.({ stream: "stderr", chunk }),
        };
  const execOptions = (stdin?: string): ExecOptions | undefined =>
    callbacks === undefined && stdin === undefined
      ? undefined
      : { ...(callbacks ?? {}), ...(stdin === undefined ? {} : { stdin }) };
  let cmd: string;
  let argv: readonly string[];
  let stdin: string | undefined;
  if (hook !== undefined) {
    const parts = substitute(hook, { ...vars, text });
    const length = argvLength(parts);
    if (length > HOOK_ARGV_LIMIT)
      throw new Error(
        `hooks.reviewCommand argv is ${length} chars (limit ${HOOK_ARGV_LIMIT}); shorten the hook template instead of ` +
          `putting {text} or {diff} in argv`,
      );
    const [hookCmd, ...hookArgv] = parts;
    cmd = hookCmd ?? d.agentCmd;
    argv = hookArgv;
  } else {
    // `-` makes omo prepend stdin to the prompt, so a large diff never has to fit in the OS argv.
    cmd = d.agentCmd;
    argv = ["-p", "--no-session", "-nt", ...(model ? ["--model", model] : []), "-"];
    stdin = text;
  }
  const res = await d.exec(cmd, argv, execOptions(stdin));
  const first = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)].at(-1);
  // A reviewer that cannot answer is a provider problem, not a verdict: retry once on the configured fallback so a
  // disabled or saturated primary never turns into a silent "no receipt" failure.
  const fallback = hook === undefined ? loadReviewSettings(d.store.root).fallbackModel : undefined;
  const retry =
    first === undefined && fallback !== undefined && fallback !== model
      ? await d
          .exec(d.agentCmd, ["-p", "--no-session", "--model", fallback, "-"], execOptions(text))
          .catch(() => undefined)
      : undefined;
  const answered = retry ?? res;
  const out = retry ? `${res.stdout}\n${retry.stdout}` : res.stdout;
  const verdicts = [...answered.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) {
    const name = `${pr.id.replaceAll("/", "__").replace("#", "_")}@${sha}-${randomUUID()}.noverdict.txt`;
    const diagnostic = join(d.store.root, "receipts", name);
    writeFileSync(diagnostic, out.split(/\r?\n/).slice(-200).join("\n"), { flag: "wx", mode: 0o600 });
    const reason =
      answered.code === 0
        ? "reviewer printed no VERDICT line"
        : `reviewer exited ${answered.code}: ${answered.stderr.trim() || "no VERDICT line in its output"}`;
    throw new Error(`${reason}; no receipt written; reviewer output saved to ${diagnostic}`);
  }
  if (answered.code !== 0) throw new Error(`reviewer exited ${answered.code}: ${answered.stderr.trim()}`);
  const verdict = last[1] as "CLEAR" | "BLOCK";
  const full = answered.stdout;
  const reviewPath = reviewTextPath(d.store.root, pr.id, sha);
  try {
    mkdirSync(join(d.store.root, "receipts"), { recursive: true });
    writeFileSync(reviewPath, capReviewText(full), { mode: 0o600 });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    process.stderr.write(`dori: could not save the full reviewer output to ${reviewPath} (${why})\n`);
  }
  d.store.saveReceipt({
    pr: pr.id,
    sha,
    verdict,
    model: hook ? "hook" : retry ? `${fallback} (fallback)` : (model ?? "default"),
    at: d.now(),
    summary: summarizeReview(full),
  });
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha };
}
