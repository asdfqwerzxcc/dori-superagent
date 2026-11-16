import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Deps } from "./harness.ts";
import { branchOf, teardownTolerated, worktreeRoot } from "./lane-worktree.ts";
import type { Lane } from "./store-types.ts";

export type WorktreeEntry = {
  readonly key: string;
  readonly path: string;
  readonly lane: Lane | undefined;
  readonly status: string;
  readonly repo: string | undefined;
  readonly exists: boolean;
  readonly registered: boolean;
  readonly dirty: string;
  readonly locks: readonly string[];
  readonly orphan: string | undefined;
};

export type WorktreeScan = {
  readonly root: string;
  readonly entries: readonly WorktreeEntry[];
  readonly orphans: number;
  readonly locks: readonly string[];
};

const norm = (path: string): string => resolve(path).replaceAll("\\", "/").toLowerCase();

async function gitOut(d: Deps, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const r = await d.exec("git", ["-C", cwd, ...argv]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

async function mainRepo(d: Deps, path: string): Promise<string | undefined> {
  const common = await gitOut(d, path, ["rev-parse", "--git-common-dir"]);
  return common === undefined ? undefined : dirname(resolve(path, common));
}

async function registeredPaths(d: Deps, repo: string): Promise<Set<string>> {
  const out = await gitOut(d, repo, ["worktree", "list", "--porcelain"]);
  const paths = new Set<string>();
  if (out === undefined) return paths;
  for (const line of out.split(/\r?\n/))
    if (line.startsWith("worktree ")) paths.add(norm(line.slice("worktree ".length)));
  return paths;
}

/** The repo's index lock and each registered tree's HEAD lock, keyed by the tree path the gitdir points at. */
async function repoLocks(repo: string): Promise<{ index?: string; head: Map<string, string> }> {
  const gitDir = join(repo, ".git");
  const head = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(join(gitDir, "worktrees"));
  } catch {
    // No registered worktrees: only the repo index lock can be stale.
  }
  for (const name of names) {
    const lock = join(gitDir, "worktrees", name, "HEAD.lock");
    if (!existsSync(lock)) continue;
    let target: string | undefined;
    try {
      target = readFileSync(join(gitDir, "worktrees", name, "gitdir"), "utf8").trim();
    } catch {
      // A lock whose gitdir is unreadable still names a tree; the caller reports it, never deletes it.
    }
    head.set(target === undefined ? name : norm(dirname(target)), lock);
  }
  const index = join(gitDir, "index.lock");
  return { ...(existsSync(index) ? { index } : {}), head };
}

const liveStatus = (lane: Lane | undefined): boolean =>
  lane !== undefined && (lane.status === "working" || lane.status === "waiting" || lane.status === "ready");

/**
 * Every dori lane worktree under `worktreeRoot`: the lanes' own recorded paths plus whatever directories are left in
 * the root. An orphan is a tree the close paths missed: its lane is done, dropped, lost or missing, its registration is
 * gone, or a stale lock marks it. A live lane's tree is never an orphan.
 */
export async function scanWorktrees(d: Deps, opts: { dirty?: boolean } = {}): Promise<WorktreeScan> {
  const root = worktreeRoot(d);
  const lanes = new Map(d.store.lanes().map((lane) => [lane.key, lane]));
  const keys = new Set<string>();
  if (existsSync(root))
    for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) keys.add(entry.name);
  for (const lane of lanes.values()) {
    if (lane.worktree === undefined) continue;
    // A closed lane whose tree is already gone has nothing to sweep; leave its record out of the list.
    if ((lane.status === "done" || lane.status === "dropped") && !existsSync(lane.worktree)) continue;
    keys.add(lane.key);
  }

  const repos = new Map<string, { registered: Set<string>; locks: { index?: string; head: Map<string, string> } }>();
  const locks = new Set<string>();
  const entries: WorktreeEntry[] = [];
  for (const key of [...keys].sort()) {
    const lane = lanes.get(key);
    const path = lane?.worktree ?? join(root, key);
    const exists = existsSync(path);
    const repo = lane?.repo ?? (exists ? await mainRepo(d, path) : undefined);
    let cache = repo === undefined ? undefined : repos.get(repo);
    if (repo !== undefined && cache === undefined) {
      cache = { registered: await registeredPaths(d, repo), locks: await repoLocks(repo) };
      repos.set(repo, cache);
      if (cache.locks.index !== undefined) locks.add(cache.locks.index);
    }
    const registered = cache?.registered.has(norm(path)) ?? false;
    // A directory git does not know and that holds nothing is not a worktree: an empty leftover from a teardown the
    // OS refused to finish must not be reported as an orphan lane tree that nobody can prune.
    if (exists && !registered && !liveStatus(lane) && readdirSync(path).length === 0) continue;
    const dirty =
      opts.dirty === false || !exists || !registered ? "" : ((await gitOut(d, path, ["status", "--porcelain"])) ?? "");
    const headLock = cache?.locks.head.get(norm(path));
    const reasons: string[] = [];
    if (!liveStatus(lane)) {
      if (!exists) reasons.push("path missing");
      else if (lane === undefined) reasons.push("no lane record");
      else if (lane.status === "done") reasons.push("lane done");
      else if (lane.status === "dropped") reasons.push("lane dropped");
      else if (lane.status === "lost") reasons.push("lane lost");
      else if (!registered) reasons.push("not registered");
      if (headLock !== undefined) reasons.push(`stale lock ${headLock}`);
      if (reasons.length > 0 && cache?.locks.index !== undefined) reasons.push(`stale lock ${cache.locks.index}`);
    }
    entries.push({
      key,
      path,
      lane,
      status: lane === undefined ? "no lane" : lane.status,
      repo,
      exists,
      registered,
      dirty,
      locks: headLock === undefined ? [] : [headLock],
      orphan: reasons.length === 0 ? undefined : reasons.join("; "),
    });
  }
  return { root, entries, orphans: entries.filter((entry) => entry.orphan !== undefined).length, locks: [...locks] };
}

export async function listWorktrees(d: Deps): Promise<void> {
  const scan = await scanWorktrees(d);
  console.log(`WORKTREES root=${scan.root}`);
  for (const entry of scan.entries) {
    const fields = [`TREE ${entry.key}`, `status=${entry.status}`, `path=${entry.path}`];
    if (entry.repo !== undefined) fields.push(`repo=${entry.repo}`);
    if (entry.orphan !== undefined) fields.push(`orphan: ${entry.orphan}`);
    if (!entry.exists) fields.push("missing");
    if (entry.dirty !== "") fields.push(`dirty=${entry.dirty.split(/\r?\n/).length}`);
    for (const lock of entry.locks) fields.push(`lock=${lock}`);
    console.log(fields.join(" "));
  }
  for (const lock of scan.locks) console.log(`LOCK ${lock}`);
  console.log(`WORKTREES ${scan.orphans} orphan`);
}

/**
 * Removes orphan trees and their `lane/<key>` branches. One line per action; a dirty tree is named and left alone, a
 * stale HEAD lock is reported and left in place, and git is never asked to force a removal.
 */
export async function pruneWorktrees(d: Deps): Promise<void> {
  const scan = await scanWorktrees(d);
  let removed = 0;
  for (const entry of scan.entries) {
    if (entry.orphan === undefined) continue;
    if (entry.locks.length > 0) {
      console.log(`LOCKED ${entry.key}: ${entry.locks.join(", ")} (left in place)`);
      continue;
    }
    if (entry.exists && entry.dirty !== "") {
      console.log(`DIRTY ${entry.key} ${entry.path}: ${entry.dirty.split(/\r?\n/)[0]}`);
      continue;
    }
    if (entry.repo === undefined) {
      console.log(`SKIPPED ${entry.key}: no repository`);
      continue;
    }
    const unlock = await d.exec("git", ["-C", entry.repo, "worktree", "unlock", entry.path]);
    if (unlock.code === 0) console.log(`UNLOCKED ${entry.key} ${entry.path}`);
    const remove = await d.exec("git", ["-C", entry.repo, "worktree", "remove", entry.path]);
    if (!teardownTolerated("remove", remove.code, remove.stderr)) {
      console.log(`FAILED ${entry.key} ${entry.path}: ${(remove.stderr || remove.stdout).trim()}`);
      continue;
    }
    console.log(`REMOVED ${entry.key} ${entry.path}`);
    const del = await d.exec("git", ["-C", entry.repo, "branch", "-D", branchOf(entry.key)]);
    if (del.code === 0) console.log(`DELETED ${branchOf(entry.key)}`);
    removed++;
  }
  console.log(`WORKTREES ${removed} pruned`);
}
