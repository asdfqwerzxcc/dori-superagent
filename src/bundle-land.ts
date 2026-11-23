// The `dori bundle land` half: build the integration branch in a disposable worktree, push it to the selected remote
// (fork when present, else origin) and create or update the one PR. Nothing here moves `main`; a conflict stops at the
// failing member and keeps the partial branch.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkedBundle, gateMember, repoKey, short } from "./bundles.ts";
import type { Deps } from "./harness.ts";
import { asSha, gitOut } from "./lane-repo.ts";
import { worktreeRoot } from "./lane-worktree.ts";
import { type OwnRemote, remoteRepo, upstreamRefusal } from "./own-remote.ts";
import { findPr } from "./pr.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";
import type { Bundle } from "./store-types.ts";

const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;
const ghWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `gh exited ${r.code}`;

export const withoutComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");

async function ownRemote(d: Deps, repoPath: string, bundleId: string): Promise<OwnRemote | undefined> {
  for (const name of ["fork", "origin"]) {
    const repo = await remoteRepo(d, repoPath, name);
    if (repo === undefined) continue;
    const remote = { name, repo };
    const why = await upstreamRefusal(d, repoPath, remote);
    if (why !== undefined)
      throw new Refusal(
        `bundle ${bundleId}: refusing to write to ${name} (${repo}): ${why}; push to your own fork instead`,
      );
    return remote;
  }
  return undefined;
}

type Preflight = { readonly repoPath: string; readonly main: string; readonly fork: OwnRemote };

/**
 * Everything land needs before it touches a branch: one checkout shared by every member, every member still CLEAR at
 * the sha it was admitted on, `main`, and a selected remote (fork, else origin) that is the bundle's and not upstream.
 */
async function preflight(d: Deps, bundle: Bundle): Promise<Preflight> {
  if (bundle.members.length === 0)
    throw new Refusal(`bundle ${bundle.id} has no members; add a lane first: dori bundle add ${bundle.id} <lane>...`);
  const repos = new Map<string, string>();
  for (const m of bundle.members) {
    const lane = d.store.lane(m.lane);
    if (lane?.repo === undefined) throw new Refusal(`bundle ${bundle.id}: lane ${m.lane} has no recorded repository`);
    repos.set(repoKey(lane.repo), lane.repo);
  }
  if (repos.size !== 1)
    throw new Refusal(`bundle ${bundle.id}: members live in different repositories: ${[...repos.values()].join(", ")}`);
  const repoPath = [...repos.values()][0]!;
  const fork = await ownRemote(d, repoPath, bundle.id);
  if (fork === undefined)
    throw new Refusal(
      `bundle ${bundle.id}: ${repoPath} has no github fork or origin remote; remote writes go to the selected remote (fork when present, else origin)`,
    );
  if (fork.repo.toLowerCase() !== bundle.repo.toLowerCase())
    throw new Refusal(
      `bundle ${bundle.id} targets ${bundle.repo}, but ${repoPath}'s ${fork.name} remote is ${fork.repo}; remote writes go to the selected remote (fork when present, else origin)`,
    );
  for (const m of bundle.members) {
    const gate = await gateMember(d, m.lane);
    if (!gate.ok) throw new Refusal(`bundle ${bundle.id}: ${gate.reason}`);
    if (gate.member.sha !== m.sha)
      throw new Refusal(
        `bundle ${bundle.id}: lane ${m.lane} moved since it was added (recorded ${short(m.sha)}, head ${short(gate.member.sha)}); ` +
          `add it again: dori bundle add ${bundle.id} ${m.lane}`,
      );
  }
  const main = asSha(await gitOut(d, repoPath, ["rev-parse", "main"]));
  if (main === undefined) throw new Refusal(`bundle ${bundle.id}: cannot read main in ${repoPath}`);
  return { repoPath, main, fork };
}

/** The PR body: the repository's template, then the member list and the one issue that may be closed. */
function prBody(template: string, bundle: Bundle): string {
  const lines = [withoutComments(template).trimEnd(), "", "## 구성원", ""];
  if (bundle.issue !== null) lines.push(`Closes #${bundle.issue}`, "");
  for (const m of bundle.members) lines.push(`- lane/${m.lane} @ ${short(m.sha)} - ${m.verdict}, ${m.reviewer}`);
  lines.push("");
  return lines.join("\n");
}

/** Creates the PR, or rewrites the title and body of the open one. A merged or closed PR is never reopened by land. */
async function upsertPr(
  d: Deps,
  bundle: Bundle,
  bodyPath: string,
): Promise<{ readonly number: number; readonly url: string }> {
  const existing = await findPr(d, bundle.repo, bundle.branch);
  if (existing !== undefined && existing.state !== "OPEN")
    throw new Refusal(
      `bundle ${bundle.id}: PR #${existing.number} is ${existing.state}; land only creates or updates an open PR`,
    );
  if (existing !== undefined) {
    const edit = await d.exec("gh", [
      "pr",
      "edit",
      String(existing.number),
      "--repo",
      bundle.repo,
      "--title",
      bundle.title,
      "--body-file",
      bodyPath,
    ]);
    if (edit.code !== 0) throw new Refusal(`bundle ${bundle.id}: gh pr edit failed: ${ghWhy(edit)}`);
    return { number: existing.number, url: existing.url };
  }
  const created = await d.exec("gh", [
    "pr",
    "create",
    "--repo",
    bundle.repo,
    "--base",
    "main",
    "--head",
    bundle.branch,
    "--title",
    bundle.title,
    "--body-file",
    bodyPath,
  ]);
  if (created.code !== 0) throw new Refusal(`bundle ${bundle.id}: gh pr create failed: ${ghWhy(created)}`);
  const url = created.stdout
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .at(-1);
  const number = url === undefined ? undefined : /\/pull\/(\d+)(?:$|[/?#])/.exec(url)?.[1];
  if (url === undefined || number === undefined)
    throw new Refusal(`bundle ${bundle.id}: gh pr create printed no PR URL: ${url ?? "(empty)"}`);
  return { number: Number(number), url };
}

/**
 * Builds `bundle/<id>` from `main` by merging every member lane with `--no-ff`, in the order they were added, pushes
 * the branch to the fork and creates or updates the PR. A conflict stops at that member and keeps the partial branch
 * for inspection. `--dry-run` prints the same plan without touching a branch, the network or a PR.
 */
export async function landBundle(d: Deps, id: string, opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const bundle = checkedBundle(d, id);
  if (bundle.status === "closed") throw new Refusal(`bundle ${id} is closed; open a new bundle`);
  const pre = await preflight(d, bundle);
  const plan = [
    `BUNDLE_LAND ${id}${opts.dryRun === true ? " (dry run)" : ""} branch=${bundle.branch} repo=${bundle.repo} ` +
      `base=main@${short(pre.main)} members=${bundle.members.length}`,
    ...bundle.members.map((m, i) => `  ${i + 1}. merge --no-ff lane/${m.lane} @ ${short(m.sha)}`),
    `  push ${pre.fork.name} ${bundle.branch}`,
    `  gh pr ${bundle.pr === null ? "create" : "edit"} --base main --head ${bundle.branch} --repo ${bundle.repo} ` +
      "(body: .github/PULL_REQUEST_TEMPLATE.md + members)",
  ];
  if (opts.dryRun === true)
    return [...plan, `LAND_DRY_RUN ${id} members=${bundle.members.length} (no branch created, no push, no PR)`];

  const templatePath = join(pre.repoPath, ".github", "PULL_REQUEST_TEMPLATE.md");
  if (!existsSync(templatePath))
    throw new Refusal(`bundle ${id}: ${templatePath} is missing; the bundle PR body comes from that template`);
  const bodyPath = join(d.store.root, "state", "bundles", `${bundle.id}.md`);
  writeFileSync(bodyPath, prBody(readFileSync(templatePath, "utf8"), bundle));

  const path = join(worktreeRoot(d), "_bundles", bundle.id);
  mkdirSync(join(worktreeRoot(d), "_bundles"), { recursive: true });
  // A previous land (or a conflict) may have left this tree behind; land rebuilds the integration branch from main.
  if (existsSync(path)) await d.exec("git", ["-C", pre.repoPath, "worktree", "remove", "--force", path]);
  await d.exec("git", ["-C", pre.repoPath, "worktree", "prune"]);
  const add = await d.exec("git", ["-C", pre.repoPath, "worktree", "add", "-B", bundle.branch, path, "main"]);
  if (add.code !== 0) throw new Refusal(`bundle ${id}: cannot create ${bundle.branch} at ${path}: ${gitWhy(add)}`);

  let merged = 0;
  for (const m of bundle.members) {
    const merge = await d.exec("git", [
      "-C",
      path,
      "merge",
      "--no-ff",
      "-m",
      `bundle ${bundle.id}: merge lane/${m.lane} (${short(m.sha)})`,
      `lane/${m.lane}`,
    ]);
    if (merge.code !== 0) {
      const conflicts = await d.exec("git", ["-C", path, "diff", "--name-only", "--diff-filter=U"]);
      await d.exec("git", ["-C", path, "merge", "--abort"]);
      const files = conflicts.stdout
        .trim()
        .split(/\r?\n/)
        .filter((f) => f !== "")
        .join(", ");
      throw new Refusal(
        `bundle ${id}: merge of lane/${m.lane} conflicted; stopped after ${merged} of ${bundle.members.length} merges ` +
          `and kept ${bundle.branch} at ${path}${files === "" ? "" : ` (conflicted: ${files})`}`,
      );
    }
    merged++;
  }

  const push = await d.exec("git", [
    "-C",
    path,
    "push",
    "--force-with-lease",
    pre.fork.name,
    `refs/heads/${bundle.branch}:refs/heads/${bundle.branch}`,
  ]);
  if (push.code !== 0)
    throw new Refusal(
      `bundle ${id}: cannot push ${bundle.branch} to ${pre.fork.name} (${bundle.repo}): ${gitWhy(push)}`,
    );
  const head = asSha(await gitOut(d, path, ["rev-parse", "HEAD"]));
  if (head === undefined) throw new Refusal(`bundle ${id}: cannot read ${bundle.branch} HEAD in ${path}`);
  const pr = await upsertPr(d, bundle, bodyPath);
  bundle.pr = pr;
  bundle.status = "landed";
  d.store.saveBundle(bundle);
  await d.exec("git", ["-C", pre.repoPath, "worktree", "remove", path]);
  return [...plan, `LANDED ${id} branch=${bundle.branch} head=${short(head)} pr=#${pr.number} ${pr.url}`];
}
