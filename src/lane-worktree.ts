import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Deps } from "./harness.ts";
import { repoHead } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";
import type { Lane } from "./store-types.ts";

export const branchOf = (key: string): string => `lane/${key}`;
const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;

/** Where lane worktrees live: `DORI_WORKTREES_DIR` when set, else `<DORI_HOME>/worktrees`. */
export const worktreeRoot = (d: Deps): string => process.env["DORI_WORKTREES_DIR"] || join(d.store.root, "worktrees");

const samePath = (a: string, b: string): boolean =>
  resolve(a).replaceAll("\\", "/").toLowerCase() === resolve(b).replaceAll("\\", "/").toLowerCase();

/** A lane's pane must start in its own worktree; a pane elsewhere commits into the shared checkout by mistake. */
export function worktreeMismatch(cwd: string | undefined, lane: Lane): string | undefined {
  if (lane.worktree === undefined || cwd === undefined || cwd === "") return undefined;
  return samePath(cwd, lane.worktree) ? undefined : `pane cwd ${cwd} is not its worktree ${lane.worktree}`;
}

export async function paneWorktreeMismatch(d: Deps, lane: Lane): Promise<string | undefined> {
  if (lane.worktree === undefined) return undefined;
  try {
    const { cwd } = await d.runtimes.for(lane.sessionRef).probe(lane.sessionRef);
    return worktreeMismatch(cwd, lane);
  } catch {
    return undefined;
  }
}

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
 * that base. A failure refuses the start: a branch this add created is removed, and there is no fallback to the shared
 * checkout.
 */
export async function createLaneWorktree(d: Deps, key: string, repo: string, baseSha: string): Promise<string> {
  const root = worktreeRoot(d);
  const path = join(root, key);
  mkdirSync(root, { recursive: true });
  warnStaleLocks(key, repo);
  await warnLongPaths(d, key, repo);
  const branch = branchOf(key);
  const existed = await d.exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const add = await d.exec("git", ["-C", repo, "worktree", "add", "-b", branch, path, baseSha]);
  if (add.code !== 0) {
    // A failed add can leave the branch behind (D13). Only delete the branch this add created: a LOST lane's
    // branch is kept until the operator drops it.
    if (existed.code !== 0) await d.exec("git", ["-C", repo, "branch", "-D", branch]);
    throw new Refusal(`worktree_unavailable: ${gitWhy(add)}`);
  }
  const lock = await d.exec("git", ["-C", repo, "worktree", "lock", "--reason", `dori lane ${key}`, path]);
  if (lock.code !== 0) {
    await discardWorktree(d, repo, key, path);
    throw new Refusal(`worktree_unavailable: cannot lock ${path}: ${gitWhy(lock)}`);
  }
  const ancestor = await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", baseSha, branch]);
  if (ancestor.code !== 0) {
    await discardWorktree(d, repo, key, path);
    throw new Refusal(
      `worktree_unavailable: ${branch} does not descend from ${baseSha.slice(0, 12)}: ${gitWhy(ancestor)}`,
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

/** `unlock` on a tree that was never locked, or `remove` on one already gone, is success rather than a refusal. */
export function teardownTolerated(kind: "unlock" | "remove", code: number, stderr: string): boolean {
  if (code === 0) return true;
  const s = stderr.toLowerCase();
  // A tree git no longer knows is already torn down; a tree that was never locked needs no unlock.
  if (s.includes("is not a working tree") || s.includes("no such file")) return true;
  return kind === "unlock" ? s.includes("is not locked") : false;
}

/** Unlocks, removes and deletes the branch of a lane's own worktree; `-d` keeps an unlanded branch, `-D` drops it. */
async function removeWorktree(d: Deps, lane: Lane, branchFlag: "-d" | "-D"): Promise<void> {
  const repo = lane.repo;
  const path = lane.worktree;
  if (repo === undefined || path === undefined) throw new Refusal(`lane ${lane.key} has no recorded worktree`);
  const unlock = await d.exec("git", ["-C", repo, "worktree", "unlock", path]);
  if (!teardownTolerated("unlock", unlock.code, unlock.stderr))
    throw new Refusal(`cannot unlock ${path}: ${gitWhy(unlock)}; branch and worktree kept`);
  let remove = await d.exec("git", ["-C", repo, "worktree", "remove", path]);
  // Windows can refuse the removal for a moment after the lane's last process exits; one retry is enough.
  if (!teardownTolerated("remove", remove.code, remove.stderr))
    remove = await d.exec("git", ["-C", repo, "worktree", "remove", path]);
  if (!teardownTolerated("remove", remove.code, remove.stderr))
    throw new Refusal(`cannot remove ${path}: ${gitWhy(remove)}; branch kept`);
  const del = await d.exec("git", ["-C", repo, "branch", branchFlag, branchOf(lane.key)]);
  // A branch already gone (a prior done, a manual delete) is not a failure: the lane still closes.
  if (del.code !== 0 && !/not found|no such branch/i.test(`${del.stderr}${del.stdout}`))
    throw new Refusal(`cannot delete ${branchOf(lane.key)}: ${gitWhy(del)}`);
}

/**
 * Moves a lane's branch onto the current `main` and re-records the base, so the receipt range stays exactly the lane's
 * own commits. The receipt at the old tip no longer applies: `done` still demands a CLEAR receipt at the new tip.
 */
export async function rebaseLaneWorktree(d: Deps, lane: Lane): Promise<string | undefined> {
  const repo = lane.repo;
  const path = lane.worktree;
  if (repo === undefined || path === undefined) return undefined;
  const head = await d.exec("git", ["-C", repo, "rev-parse", "main"]);
  if (head.code !== 0) throw new Refusal(`cannot read main in ${repo}: ${gitWhy(head)}`);
  const main = head.stdout.trim();
  if (main === lane.baseSha) return lane.baseSha;
  const rb = await d.exec("git", ["-C", path, "rebase", "main"]);
  if (rb.code !== 0) {
    await d.exec("git", ["-C", path, "rebase", "--abort"]);
    throw new Refusal(`cannot rebase lane ${lane.key} onto main: ${gitWhy(rb)}; the lane is unchanged (rebase aborted)`);
  }
  lane.baseSha = main;
  return main;
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
