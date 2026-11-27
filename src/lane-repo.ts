// The git facts a lane gate needs: which checkout a lane commits in, its HEAD, and the lane's own `base..tip` range.
// Kept apart from the review run so the gate and the reviewer read the same repository the same way.

import { join } from "node:path";
import type { Deps } from "./harness.ts";
import type { Lane } from "./store-types.ts";

const SHA_RE = /^[0-9a-f]{7,64}$/;

export const asSha = (value: string | undefined): string | undefined => {
  const sha = value?.trim();
  return sha !== undefined && SHA_RE.test(sha) ? sha : undefined;
};

export const laneGit = (d: Deps, cwd: string, argv: readonly string[]) => d.exec("git", ["-C", cwd, ...argv]);

/** Run git and return its trimmed stdout, or undefined when it exits non-zero (a missing checkout is not an exception). */
export async function gitOut(d: Deps, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const r = await laneGit(d, cwd, argv);
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

/** The `origin` remote URL of a checkout, or undefined when it has none. */
export async function repoOrigin(d: Deps, repo: string): Promise<string | undefined> {
  const url = await gitOut(d, repo, ["remote", "get-url", "origin"]);
  return url === "" ? undefined : url;
}

/** HEAD of the lane's checkout, or undefined when it cannot be read (gone directory, not a repository). */
export const laneHead = (d: Deps, lane: Lane): Promise<string | undefined> => repoHead(d, laneRepo(lane));
