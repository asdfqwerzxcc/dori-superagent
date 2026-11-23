// One lookup shared by both landing paths: the PR whose head is a branch, read from `gh`. A branch with no PR is
// `undefined`; every other gh failure is named, so "could not ask" never looks like "no PR yet".

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";

export type PrState = { readonly number: number; readonly url: string; readonly state: string };
export type ListedPr = PrState & { readonly headRefOid?: string };

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

const parseList = (head: string, text: string): ListedPr[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Refusal(`gh pr list ${head} printed no JSON`);
  }
  if (!Array.isArray(raw)) throw new Refusal(`gh pr list ${head} printed no list`);
  return raw.map((entry): ListedPr => {
    if (typeof entry !== "object" || entry === null) throw new Refusal(`gh pr list ${head} printed an incomplete PR`);
    const pr = entry as { number?: unknown; url?: unknown; state?: unknown; headRefOid?: unknown };
    if (typeof pr.number !== "number" || typeof pr.url !== "string" || typeof pr.state !== "string")
      throw new Refusal(`gh pr list ${head} printed an incomplete PR`);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      ...(typeof pr.headRefOid === "string" ? { headRefOid: pr.headRefOid } : {}),
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
    "number,url,state,headRefOid",
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
