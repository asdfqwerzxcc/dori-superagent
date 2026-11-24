// One lookup shared by both landing paths: the PR whose head is a branch, read from `gh`. A branch with no PR is
// `undefined`; every other gh failure is named, so "could not ask" never looks like "no PR yet".

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";

export type PrState = { readonly number: number; readonly url: string; readonly state: string };
export type ListedPr = PrState & {
  readonly headRefOid?: string;
  readonly baseRefName?: string;
  readonly headRepositoryOwner?: { readonly login?: string };
  readonly headRepository?: { readonly nameWithOwner?: string };
  readonly isCrossRepository?: boolean;
};

/** Why the open PR does not belong to this lane: base main, the selected head repository, and the pushed head. */
export function prIdentityRefusal(pr: ListedPr, repo: string, head: string): string | undefined {
  if (pr.baseRefName?.toLowerCase() !== "main") return `base is ${pr.baseRefName ?? "(unknown)"}, not main`;
  if (pr.isCrossRepository !== false) return "the head repository is not the selected remote (cross-repository PR)";
  const headRepo = pr.headRepository?.nameWithOwner;
  if (headRepo !== undefined && headRepo.toLowerCase() !== repo.toLowerCase())
    return `the head repository is ${headRepo}, not ${repo}`;
  const owner = pr.headRepositoryOwner?.login;
  const expectedOwner = repo.split("/")[0] ?? "";
  if (owner !== undefined && owner.toLowerCase() !== expectedOwner.toLowerCase())
    return `the head owner is ${owner}, not ${expectedOwner}`;
  if (pr.headRefOid === undefined || pr.headRefOid.toLowerCase() !== head.toLowerCase())
    return `the head is ${pr.headRefOid?.slice(0, 12) ?? "(unknown)"}, not ${head.slice(0, 12)}`;
  return undefined;
}

export async function findPr(d: Deps, repo: string, head: string): Promise<PrState | undefined> {
  const r = await d.exec("gh", ["pr", "view", head, "--repo", repo, "--json", "number,url,state"]);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim();
    if (/no pull requests? found|no open pull requests|not found/i.test(why)) return undefined;
    throw new Refusal(`gh pr view ${head} failed: ${why || `exit ${r.code}`}`);
  }
  let raw: { number?: unknown; url?: unknown; state?: unknown };
  try {
    raw = JSON.parse(r.stdout) as typeof raw;
  } catch {
    throw new Refusal(`gh pr view ${head} printed no JSON`);
  }
  if (typeof raw.number !== "number" || typeof raw.url !== "string" || typeof raw.state !== "string")
    throw new Refusal(`gh pr view ${head} printed an incomplete PR`);
  return { number: raw.number, url: raw.url, state: raw.state };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseList = (head: string, text: string): ListedPr[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Refusal(`gh pr list ${head} printed no JSON`);
  }
  if (!Array.isArray(raw)) throw new Refusal(`gh pr list ${head} printed no list`);
  return raw.map((entry): ListedPr => {
    if (!record(entry)) throw new Refusal(`gh pr list ${head} printed an incomplete PR`);
    const number = entry["number"];
    const url = entry["url"];
    const state = entry["state"];
    if (typeof number !== "number" || typeof url !== "string" || typeof state !== "string")
      throw new Refusal(`gh pr list ${head} printed an incomplete PR`);
    const headRefOid = entry["headRefOid"];
    const baseRefName = entry["baseRefName"];
    const cross = entry["isCrossRepository"];
    const owner = record(entry["headRepositoryOwner"]) ? entry["headRepositoryOwner"]["login"] : undefined;
    const headRepo = record(entry["headRepository"]) ? entry["headRepository"]["nameWithOwner"] : undefined;
    return {
      number,
      url,
      state,
      ...(typeof headRefOid === "string" ? { headRefOid } : {}),
      ...(typeof baseRefName === "string" ? { baseRefName } : {}),
      ...(typeof cross === "boolean" ? { isCrossRepository: cross } : {}),
      ...(typeof owner === "string" ? { headRepositoryOwner: { login: owner } } : {}),
      ...(typeof headRepo === "string" ? { headRepository: { nameWithOwner: headRepo } } : {}),
    };
  });
};

async function listPrs(d: Deps, repo: string, head: string, state: "open" | "all"): Promise<ListedPr[]> {
  const r = await d.exec("gh", [
    "pr",
    "list",
    "--head",
    head,
    "--repo",
    repo,
    "--state",
    state,
    "--json",
    "number,url,state,headRefOid,baseRefName,headRepositoryOwner,headRepository,isCrossRepository",
  ]);
  if (r.code !== 0)
    throw new Refusal(`gh pr list ${head} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return parseList(head, r.stdout);
}

/** The open PR for `head`, if any. */
export async function findOpenPr(d: Deps, repo: string, head: string): Promise<ListedPr | undefined> {
  const prs = await listPrs(d, repo, head, "open");
  return prs.find((pr) => pr.state.toUpperCase() === "OPEN");
}

/** A merged/closed PR for `head` whose head is exactly `sha`: that commit already landed under this branch. */
export async function findPrAtHead(d: Deps, repo: string, head: string, sha: string): Promise<ListedPr | undefined> {
  const prs = await listPrs(d, repo, head, "all");
  return prs.find((pr) => pr.state.toUpperCase() !== "OPEN" && pr.headRefOid?.toLowerCase() === sha.toLowerCase());
}
