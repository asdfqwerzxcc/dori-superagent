// The shared "which remote may be written to" rule: `fork` when present, else `origin`, but never a remote that is the
// upstream. Both lane landing and bundle land use this, so a checkout whose origin is the upstream cannot be pushed to
// by either path.

import type { Deps } from "./harness.ts";
import { repoFromRemote } from "./repo-policy.ts";

export type OwnRemote = { readonly name: string; readonly repo: string };

export async function remoteRepo(d: Deps, repoPath: string, name: string): Promise<string | undefined> {
  const r = await d.exec("git", ["-C", repoPath, "remote", "get-url", name]);
  return r.code === 0 ? repoFromRemote(r.stdout) : undefined;
}

const isUpstreamRepo = (repo: string): boolean => repo.toLowerCase().startsWith("sisyphuslabs/");

/** Why `remote` must not be written to, or undefined when it is safe: the upstream remote names it, or it is under
 * the upstream owner. */
export async function upstreamRefusal(d: Deps, repoPath: string, remote: OwnRemote): Promise<string | undefined> {
  const upstream = await remoteRepo(d, repoPath, "upstream");
  if (upstream !== undefined && upstream.toLowerCase() === remote.repo.toLowerCase())
    return `the upstream remote (${upstream}) names the same repository`;
  if (isUpstreamRepo(remote.repo)) return "it is under the upstream owner sisyphuslabs";
  return undefined;
}
