// The default landing path: one reviewed lane becomes one PR against the lane repository's own remote (its fork when
// it has one, else origin), merges as a merge commit, and its remote branch is deleted. Bundles remain the explicit
// mode for grouping several lanes into one PR.

import { short } from "./bundles.ts";
import type { Deps } from "./harness.ts";
import { asSha, laneHead, laneRepo } from "./lane-repo.ts";
import { branchOf } from "./lane-worktree.ts";
import { findPr } from "./pr.ts";
import { Refusal } from "./refusal.ts";
import { repoFromRemote } from "./repo-policy.ts";
import type { ExecResult } from "./runtime/exec.ts";
import type { Lane, LaneReceipt } from "./store-types.ts";

const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;
const ghWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `gh exited ${r.code}`;

export type LaneMergeOptions = { readonly dryRun?: boolean };

/** The lane repository's own remote: `fork` when the checkout has one, else `origin`. A fork is never required
 * (the design repository has only origin), and a fork's upstream is never a target. */
async function ownRemote(d: Deps, lane: Lane): Promise<{ readonly name: string; readonly repo: string }> {
  if (lane.repo === undefined)
    throw new Refusal(`lane ${lane.key} has no recorded repository (it started before the review gate)`);
  for (const name of ["fork", "origin"]) {
    const r = await d.exec("git", ["-C", lane.repo, "remote", "get-url", name]);
    if (r.code !== 0) continue;
    const repo = repoFromRemote(r.stdout);
    if (repo !== undefined) return { name, repo };
  }
  throw new Refusal(
    `lane ${lane.key}: ${lane.repo} has no github origin or fork remote; add one, then retry: dori merge ${lane.key}`,
  );
}

/** The lane receipt at the current head; a receipt at another commit names that sha as stale, not missing. */
function clearReceipt(d: Deps, lane: Lane, head: string): LaneReceipt {
  const key = lane.key;
  const receipt = d.store.laneReceipt(key, head);
  if (receipt === undefined) {
    const older = d.store.receipts.laneReceipts(key)[0];
    if (older !== undefined)
      throw new Refusal(
        `lane ${key} has a stale sha: reviewed ${short(older.tip)}, head ${short(head)} (run: dori review --lane ${key})`,
      );
    throw new Refusal(`lane ${key} has no review receipt at ${short(head)} (run: dori review --lane ${key})`);
  }
  if (receipt.verdict !== "CLEAR")
    throw new Refusal(`lane ${key} at ${short(head)} is ${receipt.verdict} (run: dori review --lane ${key})`);
  return receipt;
}

function prTitle(lane: Lane): string {
  const first = (lane.final?.text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first === undefined || first === "" ? branchOf(lane.key) : first;
}

function prBody(lane: Lane, head: string, receipt: LaneReceipt): string {
  const lines = [`Lane \`${branchOf(lane.key)}\` reviewed CLEAR at \`${head}\` by ${receipt.reviewer}.`, ""];
  if (lane.baseSha !== undefined) lines.push(`Base: \`${lane.baseSha}\``, "");
  if (lane.final !== undefined) {
    lines.push(lane.final.text.trim(), "");
    if (lane.final.evidence.length > 0) lines.push("Evidence:", ...lane.final.evidence.map((link) => `- ${link}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Creates the PR, or rewrites the title and body of the open one; a merged or closed PR is never reopened. */
async function upsertPr(
  d: Deps,
  lane: Lane,
  repo: string,
  branch: string,
  body: string,
): Promise<{ readonly number: number; readonly url: string }> {
  const title = prTitle(lane);
  const existing = await findPr(d, repo, branch);
  if (existing !== undefined && existing.state !== "OPEN")
    throw new Refusal(
      `lane ${lane.key}: PR #${existing.number} is ${existing.state}; merge only creates or updates an open PR`,
    );
  if (existing !== undefined) {
    const edit = await d.exec("gh", [
      "pr",
      "edit",
      String(existing.number),
      "--repo",
      repo,
      "--title",
      title,
      "--body",
      body,
    ]);
    if (edit.code !== 0) throw new Refusal(`lane ${lane.key}: gh pr edit failed: ${ghWhy(edit)}`);
    return { number: existing.number, url: existing.url };
  }
  const created = await d.exec("gh", [
    "pr",
    "create",
    "--repo",
    repo,
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (created.code !== 0) throw new Refusal(`lane ${lane.key}: gh pr create failed: ${ghWhy(created)}`);
  const url = created.stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .at(-1);
  const number = url === undefined ? undefined : /\/pull\/(\d+)(?:$|[/?#])/.exec(url)?.[1];
  if (url === undefined || number === undefined)
    throw new Refusal(`lane ${lane.key}: gh pr create printed no PR URL: ${url ?? "(empty)"}`);
  return { number: Number(number), url };
}

/**
 * Lands one lane: CLEAR receipt at the lane head, push `lane/<key>` to the lane repository's own remote, create or update
 * its PR against `main`, merge it with a merge commit, then delete the remote branch. `--dry-run` prints the same plan
 * without touching the network.
 */
export async function mergeLane(d: Deps, key: string, opts: LaneMergeOptions = {}): Promise<string[]> {
  const lane = d.store.lane(key);
  if (lane === undefined) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "dropped")
    throw new Refusal(`lane ${key} is ${lane.status}; nothing to land`);
  const path = laneRepo(lane);
  const head = asSha(await laneHead(d, lane));
  if (head === undefined) throw new Refusal(`lane ${key}: cannot read HEAD in ${path}; fix the checkout, then retry`);
  if (head === lane.baseSha) throw new Refusal(`lane ${key} has no commits to land: HEAD is its base ${short(head)}`);
  const receipt = clearReceipt(d, lane, head);
  const remote = await ownRemote(d, lane);
  const repo = remote.repo;
  const branch = branchOf(key);
  const plan = [
    `LANE_MERGE ${key}${opts.dryRun === true ? " (dry run)" : ""} repo=${repo} branch=${branch} ` +
      `head=${short(head)} receipt=CLEAR`,
    `  push ${remote.name} ${branch}`,
    `  gh pr create|edit --repo ${repo} --base main --head ${branch}`,
    `  gh pr merge --merge --match-head-commit ${head}`,
    `  git push ${remote.name} --delete ${branch}`,
  ];
  if (opts.dryRun === true) return [...plan, `LANE_MERGE_DRY_RUN ${key} (no push, no PR, no merge)`];

  const push = await d.exec("git", ["-C", path, "push", remote.name, `${head}:refs/heads/${branch}`]);
  if (push.code !== 0)
    throw new Refusal(`lane ${key}: cannot push ${branch} to ${remote.name} (${repo}): ${gitWhy(push)}`);
  const pr = await upsertPr(d, lane, repo, branch, prBody(lane, head, receipt));
  const merged = await d.exec("gh", [
    "pr",
    "merge",
    String(pr.number),
    "--repo",
    repo,
    "--merge",
    "--match-head-commit",
    head,
  ]);
  if (merged.code !== 0)
    throw new Refusal(
      `lane ${key}: PR #${pr.number} (${pr.url}) did not merge: ${ghWhy(merged)}; the remote branch was kept`,
    );
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  const del = await d.exec("git", ["-C", path, "push", remote.name, "--delete", branch]);
  const branchState = del.code === 0 ? "deleted" : `delete failed: ${gitWhy(del)}`;
  return [
    ...plan,
    `MERGED ${branch} head=${short(head)} repo=${repo} pr=#${pr.number} ${pr.url} branch=${branchState}`,
  ];
}
