// The built-in PR reviewer: one fresh non-interactive reviewer pinned to the PR head, its verdict written as a
// receipt. Kept out of the merge gate so the gate stays a rule module and this stays the process that feeds it.

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gh, headSha, parsePr } from "./gate.ts";
import { prompt, type Deps } from "./harness.ts";
import { loadHooks, loadReviewSettings, substitute } from "./hooks.ts";
import type { ExecOptions } from "./runtime/exec.ts";

/** Windows caps one CreateProcess command line near 32,767 chars; leave room for the executable and its flags. */
const HOOK_ARGV_LIMIT = 30_000;

const argvLength = (argv: readonly string[]): number => argv.reduce((total, part) => total + part.length + 1, 0);

/** One chunk of a reviewer's output as it arrives; the background worker records it as progress. */
export type ReviewOutput = { readonly stream: "stdout" | "stderr"; readonly chunk: string };
export type ReviewOptions = { readonly onOutput?: (out: ReviewOutput) => void };

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
  const view = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "title,body"]));
  const diff = await gh(d, ["pr", "diff", String(pr.number), "--repo", pr.repo]);
  const vars = {
    pr: pr.id,
    repo: pr.repo,
    number: String(pr.number),
    sha,
    title: `${String(view.title ?? "")}\n\n${String(view.body ?? "")}`.trim(),
    diff,
  };
  const text = prompt("review.md", vars);
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
  d.store.saveReceipt({
    pr: pr.id,
    sha,
    verdict,
    model: hook ? "hook" : retry ? `${fallback} (fallback)` : (model ?? "default"),
    at: d.now(),
    summary: answered.stdout.trim().slice(-4000),
  });
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha };
}
