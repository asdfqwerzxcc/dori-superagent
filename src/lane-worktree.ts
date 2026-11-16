import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { repoHead } from "./lane-gate.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";
import type { Lane } from "./store-types.ts";

const branchOf = (key: string): string => `lane/${key}`;
const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;

/** Warn about a lock a previous git process left behind; never delete it (another process may still hold it). */
function warnStaleLocks(key: string, repo: string): void {
  const gitDir = join(repo, ".git");
  const locks = [join(gitDir, "index.lock")];
  try {
    for (const name of readdirSync(join(gitDir, "worktrees"))) locks.push(join(gitDir, "worktrees", name, "HEAD.lock"));
  } catch {
    // No worktrees directory (or `.git` is a file): there is nothing to scan.
  }
  for (const lock of locks)
    if (existsSync(lock)) console.log(`WARN lane ${key}: stale git lock ${lock} (left in place)`);
}

/** Warn when Windows long paths are off: lane paths are short, the checkouts inside them need not be. */
async function warnLongPaths(d: Deps, key: string, repo: string): Promise<void> {
  const r = await d.exec("git", ["-C", repo, "config", "--get", "core.longpaths"]);
  if (r.code === 0 && r.stdout.trim() === "true") return;
  console.log(
    `WARN lane ${key}: core.longpaths is not true in ${repo}; enable it with: git -C ${repo} config core.longpaths true`,
  );
}

export async function discardWorktree(d: Deps, repo: string, key: string, path: string): Promise<void> {
  await d.exec("git", ["-C", repo, "worktree", "unlock", path]);
  await d.exec("git", ["-C", repo, "worktree", "remove", path]);
  await d.exec("git", ["-C", repo, "branch", "-D", branchOf(key)]);
}

/**
 * Creates and locks the lane's own checkout on branch `lane/<key>` from `baseSha`, and proves the branch descends from
 * that base. A failure refuses the start: the branch the failed add may have created is removed, and there is no
 * fallback to the shared checkout.
 */
export async function createLaneWorktree(d: Deps, key: string, repo: string, baseSha: string): Promise<string> {
  const path = join(d.store.root, "worktrees", key);
  mkdirSync(join(d.store.root, "worktrees"), { recursive: true });
  warnStaleLocks(key, repo);
  await warnLongPaths(d, key, repo);
  const add = await d.exec("git", ["-C", repo, "worktree", "add", "-b", branchOf(key), path, baseSha]);
  if (add.code !== 0) {
    // A failed add can leave the branch behind (D13); drop it so a retry is not "branch already exists".
    await d.exec("git", ["-C", repo, "branch", "-D", branchOf(key)]);
    throw new Refusal(`worktree_unavailable: ${gitWhy(add)}`);
  }
  const lock = await d.exec("git", ["-C", repo, "worktree", "lock", "--reason", `dori lane ${key}`, path]);
  if (lock.code !== 0) {
    await discardWorktree(d, repo, key, path);
    throw new Refusal(`worktree_unavailable: cannot lock ${path}: ${gitWhy(lock)}`);
  }
  const ancestor = await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", baseSha, branchOf(key)]);
  if (ancestor.code !== 0) {
    await discardWorktree(d, repo, key, path);
    throw new Refusal(
      `worktree_unavailable: ${branchOf(key)} does not descend from ${baseSha.slice(0, 12)}: ${gitWhy(ancestor)}`,
    );
  }
  return path;
}

/** Refuses a close while the lane's worktree has uncommitted or untracked files, naming them exactly as git does. */
export async function assertCleanWorktree(d: Deps, lane: Lane): Promise<void> {
  const path = lane.worktree;
  if (path === undefined) return;
  const st = await d.exec("git", ["-C", path, "status", "--porcelain"]);
  if (st.code !== 0) throw new Refusal(`cannot read lane ${lane.key} worktree ${path}: ${gitWhy(st)}`);
  const dirty = st.stdout.trim();
  if (dirty !== "")
    throw new Refusal(`lane ${lane.key} worktree has uncommitted changes; commit or drop them first:\n${dirty}`);
}

/** Unlocks, removes and deletes the branch of a lane's own worktree; `-d` keeps an unlanded branch, `-D` drops it. */
async function removeWorktree(d: Deps, lane: Lane, branchFlag: "-d" | "-D"): Promise<void> {
  const repo = lane.repo;
  const path = lane.worktree;
  if (repo === undefined || path === undefined) throw new Refusal(`lane ${lane.key} has no recorded worktree`);
  const unlock = await d.exec("git", ["-C", repo, "worktree", "unlock", path]);
  if (unlock.code !== 0) throw new Refusal(`cannot unlock ${path}: ${gitWhy(unlock)}; branch and worktree kept`);
  const remove = await d.exec("git", ["-C", repo, "worktree", "remove", path]);
  if (remove.code !== 0) throw new Refusal(`cannot remove ${path}: ${gitWhy(remove)}; branch kept`);
  const del = await d.exec("git", ["-C", repo, "branch", branchFlag, branchOf(lane.key)]);
  if (del.code !== 0) throw new Refusal(`cannot delete ${branchOf(lane.key)}: ${gitWhy(del)}`);
}

/**
 * Lands the lane's branch on the main checkout and tears its worktree down. Fast-forward only, and only while `main`
 * still sits at the lane's recorded base; a main that moved refuses and keeps both, unless the branch already landed.
 */
export async function landWorktree(d: Deps, lane: Lane): Promise<string> {
  const repo = lane.repo;
  const base = lane.baseSha;
  if (repo === undefined || base === undefined || lane.worktree === undefined)
    throw new Refusal(`lane ${lane.key} has a worktree but no recorded repo/base`);
  const branch = branchOf(lane.key);
  const head = await repoHead(d, repo);
  if (head === undefined) throw new Refusal(`cannot read main HEAD in ${repo}; branch and worktree kept`);
  if (head !== base) {
    // A retried done after this branch already landed is fine; a main that moved for another reason is not.
    const merged = await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", branch, "HEAD"]);
    if (merged.code !== 0)
      throw new Refusal(
        `main moved: rebase required (lane ${lane.key} base ${base.slice(0, 12)}, main ${head.slice(0, 12)}); branch and worktree kept`,
      );
  } else {
    const merge = await d.exec("git", ["-C", repo, "merge", "--ff-only", branch]);
    if (merge.code !== 0)
      throw new Refusal(`cannot land ${branch} on main: ${gitWhy(merge)}; branch and worktree kept`);
  }
  await removeWorktree(d, lane, "-d");
  return `landed ${branch} on main`;
}

/**
 * Closes a lane and removes its worktree and branch without landing anything on `main`. The explicit exit for a lane
 * whose base moved, or for abandoned work: it never merges, and an unclean tree refuses removal with git's reason.
 */
export async function dropLane(d: Deps, lane: Lane, reason: string): Promise<string> {
  if (lane.status === "done") throw new Refusal(`lane ${lane.key} is already done`);
  if (!reason.trim()) throw new Refusal("done --drop needs a non-empty --reason");
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st !== "gone") await rt.close(lane.sessionRef);
  if (lane.worktree !== undefined) await removeWorktree(d, lane, "-D");
  lane.status = "dropped";
  lane.log.push({ at: d.now(), kind: "dropped", text: reason.trim() });
  d.store.saveLane(lane);
  return `dropped: ${reason.trim()}`;
}
