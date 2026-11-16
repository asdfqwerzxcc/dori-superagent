import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prompt, type Deps } from "./harness.ts";
import { loadHooks, substitute } from "./hooks.ts";
import { Refusal } from "./refusal.ts";
import { KEY_RE, type Lane } from "./store-types.ts";

const SHA_RE = /^[0-9a-f]{7,64}$/;

const asSha = (value: string | undefined): string | undefined => {
  const sha = value?.trim();
  return sha !== undefined && SHA_RE.test(sha) ? sha : undefined;
};

const git = (d: Deps, cwd: string, argv: readonly string[]) => d.exec("git", ["-C", cwd, ...argv]);

/** Run git and return its trimmed stdout, or undefined when it exits non-zero (a missing checkout is not an exception). */
async function gitOut(d: Deps, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const r = await git(d, cwd, argv);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** The checkout a lane's commits live in: its own worktree, else the checkout recorded at start, else its cwd. */
export const laneRepo = (lane: Lane): string => lane.worktree ?? lane.repo ?? lane.cwd;

/** The checkout a starting lane will commit in: its cwd when that is a repo, else the harness checkout `<home>/src`. */
export async function resolveLaneRepo(d: Deps, cwd: string): Promise<string | undefined> {
  return (
    (await gitOut(d, cwd, ["rev-parse", "--show-toplevel"])) ??
    (await gitOut(d, join(d.store.root, "src"), ["rev-parse", "--show-toplevel"]))
  );
}

/** HEAD of a checkout, or undefined when the path is gone or is not a git repository. */
export async function repoHead(d: Deps, repo: string): Promise<string | undefined> {
  return asSha(await gitOut(d, repo, ["rev-parse", "HEAD"]));
}

/** HEAD of the lane's checkout, or undefined when it cannot be read (gone directory, not a repository). */
export const laneHead = (d: Deps, lane: Lane): Promise<string | undefined> => repoHead(d, laneRepo(lane));

export type LaneReview = { readonly verdict: "CLEAR" | "BLOCK"; readonly base: string; readonly tip: string };

/**
 * Reviews one lane's own commits: the merge-base of its recorded start commit and the current tip, diffed at that tip.
 * Writes `receipts/lane_<key>@<tip>.json`; a reviewer that prints no VERDICT line leaves only the private diagnostic
 * and writes no receipt, so a receipt can never describe a different diff.
 */
export async function reviewLane(d: Deps, key: string, model?: string): Promise<LaneReview> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.baseSha === undefined)
    throw new Refusal(
      `lane ${key} has no recorded base commit (it started before the review gate); dori review --lane covers lanes started by this version`,
    );
  const repo = laneRepo(lane);
  const tip = await laneHead(d, lane);
  if (tip === undefined)
    throw new Refusal(`cannot read HEAD in ${repo}: the lane's checkout is gone or not a git repository`);
  const base = asSha(await gitOut(d, repo, ["merge-base", lane.baseSha, tip]));
  if (base === undefined)
    throw new Refusal(`cannot find the merge-base of ${lane.baseSha.slice(0, 12)} and ${tip.slice(0, 12)} in ${repo}`);
  if (base === tip) throw new Refusal(`lane ${key} has no commits since ${base.slice(0, 12)}; nothing to review`);

  const diff = await git(d, repo, ["--no-pager", "diff", "--no-color", "--no-ext-diff", `${base}..${tip}`]);
  if (diff.code !== 0)
    throw new Refusal(
      `git diff ${base.slice(0, 12)}..${tip.slice(0, 12)} failed: ${(diff.stderr || diff.stdout).trim()}`,
    );
  const diffPath = d.store.laneDiffPath(key, tip);
  writeFileSync(diffPath, diff.stdout);

  const text = prompt("review-lane.md", { key, base, tip, brief: lane.brief, diff: diffPath, repo });
  // hooks.reviewCommand replaces the built-in reviewer for lanes too; it must print a VERDICT line like the built-in one.
  const hook = loadHooks(d.store.root).reviewCommand;
  const vars = { lane: key, key, base, tip, sha: tip, brief: lane.brief, diff: diffPath, repo };
  const [cmd, ...argv] = hook
    ? substitute(hook, vars)
    : [d.agentCmd, "-p", "--no-session", ...(model ? ["--model", model] : []), text];
  const res = await d.exec(cmd ?? d.agentCmd, argv);
  const verdicts = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) {
    const name = `lane_${key}@${tip}-${randomUUID()}.noverdict.txt`;
    const diagnostic = join(d.store.root, "receipts", name);
    writeFileSync(diagnostic, res.stdout.split(/\r?\n/).slice(-200).join("\n"), { flag: "wx", mode: 0o600 });
    const reason =
      res.code === 0
        ? "reviewer printed no VERDICT line"
        : `reviewer exited ${res.code}: ${res.stderr.trim() || "no VERDICT line in its output"}`;
    throw new Refusal(`${reason}; no receipt written; reviewer output saved to ${diagnostic}`);
  }
  if (res.code !== 0) throw new Refusal(`reviewer exited ${res.code}: ${res.stderr.trim()}`);

  const verdict = last[1] as "CLEAR" | "BLOCK";
  const reviewer = hook
    ? `hook: ${hook.join(" ")}`
    : `${d.agentCmd} -p --no-session${model ? ` --model ${model}` : ""}`;
  d.store.saveLaneReceipt({
    lane: key,
    verdict,
    base,
    tip,
    brief: lane.brief,
    reviewer,
    at: d.now(),
    summary: res.stdout.trim().slice(-4000),
  });
  lane.tipSha = tip;
  d.store.saveLane(lane);
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, base, tip };
}

export type LaneGate = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly reason: string };

/**
 * What `dori done` asks before closing: the current tip has a CLEAR receipt, or the lane committed nothing (base ===
 * tip), or the lane has no recorded base (started before the gate) and closes with an explicit note.
 */
export async function laneGate(d: Deps, lane: Lane): Promise<LaneGate> {
  if (lane.baseSha === undefined)
    return { ok: true, note: `no review gate: lane ${lane.key} has no recorded base commit` };
  const tip = await laneHead(d, lane);
  if (tip === undefined)
    return {
      ok: false,
      reason: `lane ${lane.key}: cannot read HEAD in ${laneRepo(lane)}; fix the checkout, then run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  if (tip === lane.baseSha) return { ok: true };
  const receipt = d.store.laneReceipt(lane.key, tip);
  if (!receipt)
    return {
      ok: false,
      reason: `lane ${lane.key} at ${tip.slice(0, 12)} has no review receipt; run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  if (receipt.verdict !== "CLEAR")
    return {
      ok: false,
      reason: `lane ${lane.key} at ${tip.slice(0, 12)} is ${receipt.verdict}; fix it, then run: dori review --lane ${lane.key} (or dori done --drop ${lane.key} --reason <text>)`,
    };
  return { ok: true };
}

/** `reviewed`, `BLOCK` or `no receipt` for one lane row in `dori status`, read at the lane's current tip. */
export async function reviewLabel(d: Deps, lane: Lane): Promise<string> {
  if (lane.baseSha === undefined) return "no receipt";
  const tip = (await laneHead(d, lane)) ?? lane.tipSha;
  if (tip === undefined) return "no receipt";
  const receipt = d.store.laneReceipt(lane.key, tip);
  if (!receipt) return "no receipt";
  return receipt.verdict === "CLEAR" ? "reviewed" : "BLOCK";
}
