import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleGate } from "./bundles.ts";
import { prompt, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { loadHooks, loadReviewSettings, substitute } from "./hooks.ts";
import type { MergeOutcome } from "./telemetry.ts";

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
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
 * Merge only when the review dimension is satisfied and every check passed. The review dimension is a CLEAR receipt at
 * the exact current head, or with `--bundle` every recorded member still CLEAR at the sha it was admitted on. An empty
 * check list is never green, whichever path supplied the review.
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
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}
