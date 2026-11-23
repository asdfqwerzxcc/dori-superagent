import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleGate } from "./bundles.ts";
import { prompt, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { loadHooks, loadReviewSettings, substitute } from "./hooks.ts";
import type { MergeOutcome } from "./telemetry.ts";

export type PrRef = { repo: string; number: number; id: string };

const PR_ID_RE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** A PR id (`owner/repo#123`) and a lane key never overlap: a key cannot contain `/` or `#`. */
export const isPrId = (s: string): boolean => PR_ID_RE.test(s);

export function parsePr(s: string): PrRef {
  const m = PR_ID_RE.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Records a receipt for a review that already happened elsewhere (a gate-reviewer subagent, a human, an external tool).
 * The built-in reviewer spawns `omo -p`, which stalls on long prompts on this host, so this is the reliable path: the
 * caller names the reviewer and the evidence it rested on, and the receipt still binds to the PR's exact head. */
export async function attest(
  d: Deps,
  prId: string,
  opts: { verdict: "CLEAR" | "BLOCK"; reviewer: string; summary?: string | undefined; evidence: readonly string[] },
): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  if (opts.evidence.length === 0)
    throw new Refusal("--attest needs at least one --evidence link (task id, path or url)");
  d.store.saveReceipt({
    pr: pr.id,
    sha,
    verdict: opts.verdict,
    model: `attested: ${opts.reviewer}`,
    at: d.now(),
    summary: [opts.summary ?? "", ...opts.evidence].filter(Boolean).join("\n"),
  });
  d.usage.record({ name: "dori.review_completed", verdict: opts.verdict });
  return { verdict: opts.verdict, sha };
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(
  d: Deps,
  prId: string,
  model?: string,
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
  const [cmd, ...argv] = hook
    ? substitute(hook, { ...vars, text })
    : [d.agentCmd, "-p", "--no-session", "-nt", ...(model ? ["--model", model] : []), text];
  const res = await d.exec(cmd ?? d.agentCmd, argv);
  const first = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)].at(-1);
  // A reviewer that cannot answer is a provider problem, not a verdict: retry once on the configured fallback so a
  // disabled or saturated primary never turns into a silent "no receipt" failure.
  const fallback = hook === undefined ? loadReviewSettings(d.store.root).fallbackModel : undefined;
  const retry =
    first === undefined && fallback !== undefined && fallback !== model
      ? await d.exec(d.agentCmd, ["-p", "--no-session", "--model", fallback, text]).catch(() => undefined)
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

type Check = { name: string; bucket: string };

/**
 * Merge only when the review dimension is satisfied and every configured check passed. The review dimension is a CLEAR
 * receipt at the exact current head, or with `--bundle` every recorded member still CLEAR at the sha it was admitted on.
 * `checks=none` requires gh's no-checks answer and a repository with no workflows; pending, failed, skipped-only,
 * unreadable or failed gh calls refuse.
 */
export async function mergeGate(
  d: Deps,
  prId: string,
  opts: { dryRun?: boolean; bundle?: string } = {},
): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha, opts.bundle);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(
  d: Deps,
  pr: PrRef,
  sha: string,
  bundleId?: string,
): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (receipt === undefined || receipt.verdict !== "CLEAR") {
    if (bundleId !== undefined) {
      const why = await bundleGate(d, bundleId, { repo: pr.repo, number: pr.number });
      if (why !== undefined) return ["bundle_members", why];
    } else if (receipt === undefined) {
      return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
    } else {
      return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
    }
  }
  return checksRefusal(d, pr);
}

/** The check dimension alone, shared by the PR gate, the bundle gate and the lane gate. `none` is true only when no
 * check ran (`gh` reported no checks, or every check was skipped) and the repository has no workflows; any other
 * uncertain answer is a refusal. */
export type CheckGate = { readonly none: boolean; readonly refusal?: [MergeOutcome, string] };

const checkRefusal = (why: string): CheckGate => ({ none: false, refusal: ["checks_red", why] });

const NO_CHECKS_RE = /no checks reported/i;

const isCheck = (value: unknown): value is Check =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Check).name === "string" &&
  typeof (value as Check).bucket === "string";

async function workflowCount(
  d: Deps,
  repo: string,
): Promise<{ readonly count?: number; readonly refusal?: [MergeOutcome, string] }> {
  const r = await d.exec("gh", ["api", `repos/${repo}/actions/workflows`, "--jq", ".total_count"]);
  const why = (r.stderr || r.stdout).trim();
  if (r.code !== 0)
    return {
      refusal: ["checks_red", `cannot read workflow count for ${repo} (exit ${r.code}): ${why || "no output"}`],
    };
  if (r.stderr.trim() !== "")
    return { refusal: ["checks_red", `gh api workflows wrote to stderr: ${r.stderr.trim()}`] };
  const count = Number(r.stdout.trim());
  if (!Number.isInteger(count) || count < 0)
    return { refusal: ["checks_red", `workflow count for ${repo} is not a number: ${r.stdout.trim() || "(empty)"}`] };
  return { count };
}

export async function checkGate(d: Deps, pr: { readonly repo: string; readonly number: number }): Promise<CheckGate> {
  const r = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const stdout = r.stdout.trim();
  const stderr = r.stderr.trim();
  if (r.code === 1 && stdout === "" && NO_CHECKS_RE.test(stderr)) {
    const wf = await workflowCount(d, pr.repo);
    if (wf.refusal !== undefined) return checkRefusal(wf.refusal[1]);
    if (wf.count === 0) return { none: true };
    return checkRefusal(
      `no checks reported but ${pr.repo} has ${wf.count} workflow(s); checks may not have registered`,
    );
  }
  if (r.code !== 0) return checkRefusal(`gh pr checks failed (exit ${r.code}): ${stderr || stdout || "no output"}`);
  if (stderr !== "") return checkRefusal(`gh pr checks wrote to stderr: ${stderr}`);
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return checkRefusal(`gh pr checks printed unreadable output: ${stdout || "(empty)"}`);
  }
  if (!Array.isArray(raw) || !raw.every(isCheck)) return checkRefusal("gh pr checks printed an unreadable check list");
  const checks = raw as Check[];
  if (checks.length === 0) return checkRefusal("gh pr checks returned an empty list without the no-checks reason");
  if (checks.every((c) => c.bucket === "skipping")) {
    const wf = await workflowCount(d, pr.repo);
    if (wf.refusal !== undefined) return checkRefusal(wf.refusal[1]);
    if (wf.count === 0) return { none: true };
    return checkRefusal(`all ${checks.length} checks are skipped; no check ran`);
  }
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return checkRefusal(`checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`);
  return { none: false };
}

/** The refusal form shared by the PR and bundle gates. */
export async function checksRefusal(
  d: Deps,
  pr: { readonly repo: string; readonly number: number },
): Promise<[MergeOutcome, string] | undefined> {
  return (await checkGate(d, pr)).refusal;
}
