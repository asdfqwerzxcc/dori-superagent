// The default landing path: one reviewed lane becomes one PR against the lane repository's own remote (its fork when
// it has one, else origin), merges as a merge commit, and its remote branch is deleted. Bundles remain the explicit
// mode for grouping several lanes into one PR.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { short } from "./bundles.ts";
import { checksRefusal } from "./gate.ts";
import type { Deps } from "./harness.ts";
import { asSha, laneHead, laneRepo } from "./lane-repo.ts";
import { branchOf } from "./lane-worktree.ts";
import { type OwnRemote, remoteRepo, upstreamRefusal } from "./own-remote.ts";
import { findOpenPr, findPrAtHead } from "./pr.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";
import { KEY_RE, type Lane, type LaneReceipt } from "./store-types.ts";

const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;
const ghWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `gh exited ${r.code}`;
const TITLE_MAX = 256;

const clipTitle = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= TITLE_MAX ? one : `${one.slice(0, TITLE_MAX - 3).trimEnd()}...`;
};

function briefTitle(lane: Lane): string | undefined {
  let text: string;
  try {
    text = readFileSync(lane.brief, "utf8");
  } catch {
    return undefined;
  }
  const heading = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("#"));
  const title = heading?.replace(/^#+\s*/, "").trim();
  return title === undefined || title === "" ? undefined : title;
}

export type LaneMergeOptions = { readonly dryRun?: boolean };

/** The lane repository's own remote: `fork` when the checkout has one, else `origin`. A fork is never required
 * (the design repository has only origin), and a selected remote that is the upstream is refused, not written. */
async function ownRemote(d: Deps, lane: Lane): Promise<OwnRemote> {
  if (lane.repo === undefined)
    throw new Refusal(`lane ${lane.key} has no recorded repository (it started before the review gate)`);
  for (const name of ["fork", "origin"]) {
    const repo = await remoteRepo(d, lane.repo, name);
    if (repo === undefined) continue;
    const remote = { name, repo };
    const why = await upstreamRefusal(d, lane.repo, remote);
    if (why !== undefined)
      throw new Refusal(
        `lane ${lane.key}: refusing to push ${branchOf(lane.key)} to ${name} (${repo}): ${why}; push to your own fork instead`,
      );
    return remote;
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
  const heading = briefTitle(lane);
  if (heading !== undefined) return clipTitle(heading);
  const answer = (lane.final?.text ?? "").replace(/^READY\s+[^\n]*(?:\n+|$)/i, "");
  const firstLine = answer
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  const firstSentence = firstLine?.split(/(?<=[.!?。])\s+/)[0] ?? firstLine ?? "";
  return clipTitle(firstSentence === "" ? branchOf(lane.key) : firstSentence);
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

/** Creates the PR, or rewrites the title and body of the open one; a merged PR at an older head never blocks a reused key. */
async function upsertPr(
  d: Deps,
  lane: Lane,
  repo: string,
  branch: string,
  head: string,
  bodyPath: string,
): Promise<{ readonly number: number; readonly url: string }> {
  const title = prTitle(lane);
  const existing = await findOpenPr(d, repo, branch);
  if (existing !== undefined) {
    const edit = await d.exec("gh", [
      "pr",
      "edit",
      String(existing.number),
      "--repo",
      repo,
      "--title",
      title,
      "--body-file",
      bodyPath,
    ]);
    if (edit.code !== 0) throw new Refusal(`lane ${lane.key}: gh pr edit failed: ${ghWhy(edit)}`);
    return { number: existing.number, url: existing.url };
  }
  const landed = await findPrAtHead(d, repo, branch, head);
  if (landed !== undefined)
    throw new Refusal(
      `lane ${lane.key}: PR #${landed.number} is ${landed.state} at this exact head ${short(head)}; nothing new to land`,
    );
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
    "--body-file",
    bodyPath,
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
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
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
    `  gh pr checks <new PR> --repo ${repo} (all pass)`,
    `  gh pr merge --merge --match-head-commit ${head}`,
    `  git push ${remote.name} --delete ${branch}`,
  ];
  if (opts.dryRun === true) return [...plan, `LANE_MERGE_DRY_RUN ${key} (no push, no PR, no merge)`];

  const bodyPath = join(d.store.root, "state", "lane-prs", `${lane.key}.md`);
  mkdirSync(dirname(bodyPath), { recursive: true });
  writeFileSync(bodyPath, prBody(lane, head, receipt));
  const push = await d.exec("git", ["-C", path, "push", remote.name, `${head}:refs/heads/${branch}`]);
  if (push.code !== 0)
    throw new Refusal(`lane ${key}: cannot push ${branch} to ${remote.name} (${repo}): ${gitWhy(push)}`);
  const pr = await upsertPr(d, lane, repo, branch, head, bodyPath);
  const checks = await checksRefusal(d, { repo, number: pr.number });
  if (checks !== undefined) {
    d.usage.record({ name: "dori.merge_decided", outcome: checks[0] });
    throw new Refusal(
      `MERGE_REFUSED lane ${key}: PR #${pr.number} (${pr.url}) is not green: ${checks[1]}; ` +
        `rerun dori merge ${key} once checks pass`,
    );
  }
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
  const deleteWhy = (del.stderr || del.stdout).trim();
  const deleted = del.code === 0 || /remote ref does not exist/i.test(deleteWhy);
  return [
    ...plan,
    `MERGED ${branch} head=${short(head)} repo=${repo} pr=#${pr.number} ${pr.url} branch=${deleted ? "deleted" : "kept"}`,
    ...(deleted
      ? []
      : [
          `WARN lane ${key}: merged, but the remote branch ${branch} was kept: ${deleteWhy || `git exited ${del.code}`}`,
        ]),
  ];
}
