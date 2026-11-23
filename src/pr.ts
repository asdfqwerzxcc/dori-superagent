// One lookup shared by both landing paths: the PR whose head is a branch, read from `gh`. A branch with no PR is
// `undefined`; every other gh failure is named, so "could not ask" never looks like "no PR yet".

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";

export type PrState = { readonly number: number; readonly url: string; readonly state: string };

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
