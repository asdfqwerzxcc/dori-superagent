import { join } from "node:path";
import { readJson } from "./json-file.ts";
import { Refusal } from "./refusal.ts";

/** The repositories the GitHub sweep commands may write to; every other repo is dry-run only. */
export type RepoPolicy = { readonly allow: readonly string[]; readonly readOnly: readonly string[] };

export const DEFAULT_POLICY: RepoPolicy = { allow: [], readOnly: [] };

/** The policy ships with the tool, so it lives in this checkout rather than in DORI_HOME. */
export const policyPath = (): string => join(import.meta.dir, "..", "config", "repos.json");

const repoList = (value: unknown, field: string): readonly string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Refusal(`config/repos.json: ${field} must be a list of owner/repo strings`);
  return value.map((v: string) => v.trim().toLowerCase());
};

export function loadRepoPolicy(path: string = policyPath()): RepoPolicy {
  const raw = readJson<{ allow?: unknown; readOnly?: unknown }>(path);
  if (raw === undefined) return DEFAULT_POLICY;
  return { allow: repoList(raw.allow, "allow"), readOnly: repoList(raw.readOnly, "readOnly") };
}

/** owner/repo as GitHub writes it; `gh` keeps the case, the policy compares without it. */
export function checkRepo(repo: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refusal(`repo must look like owner/name, got ${repo}`);
  return repo;
}

const policyKey = (repo: string): string => repo.trim().toLowerCase();

export const writable = (policy: RepoPolicy, repo: string): boolean => {
  const key = policyKey(repo);
  return policy.allow.includes(key) && !policy.readOnly.includes(key);
};

/** A dry run reads anything; `--apply` is refused unless the allowlist names the repo writable. */
export function assertWritable(policy: RepoPolicy, repo: string, apply: boolean): void {
  if (!apply || writable(policy, repo)) return;
  throw new Refusal(
    `${repo} is read-only for labels/stale: config/repos.json does not allow it (or lists it in readOnly); run without --apply to see the plan`,
  );
}

export type Remote = { readonly host: string; readonly path: string };

/** `git@host:group/project.git`, `https://host/group/project`, and `ssh://git@host:2222/group/project` name a host and path. */
export function remoteOf(url: string): Remote | undefined {
  const text = url.trim();
  if (text === "") return undefined;
  let host: string;
  let raw: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return undefined;
    }
    host = parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
    raw = parsed.pathname;
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(text);
    if (scp === null) return undefined;
    host = scp[1]!;
    raw = scp[2]!;
  }
  const path = raw
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const parts = path.split("/").filter(Boolean);
  if (host === "" || parts.length < 2) return undefined;
  return { host: host.toLowerCase(), path: parts.join("/") };
}

/** `git@github.com:owner/repo.git` and `https://github.com/owner/repo` name the same repository. */
export function repoFromRemote(url: string): string | undefined {
  const remote = remoteOf(url);
  return remote?.host === "github.com" ? remote.path : undefined;
}
