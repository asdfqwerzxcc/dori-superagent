// Bundles: several finished lanes land as one `bundle/<id>` branch and one MR. A member is admitted on its own lane
// receipt (CLEAR at the branch head) and re-checked on that same sha before the integration branch is built.

import { resolve } from "node:path";
import type { Deps } from "./harness.ts";
import { asSha, gitOut } from "./lane-repo.ts";
import { Refusal } from "./refusal.ts";
import { checkRepo } from "./repo-policy.ts";
import { KEY_RE, type Bundle, type BundleMember } from "./store-types.ts";

export const short = (sha: string): string => sha.slice(0, 12);
export const repoKey = (path: string): string => resolve(path).replaceAll("\\", "/").toLowerCase();

export type MemberGate =
  | { readonly ok: true; readonly member: BundleMember }
  | { readonly ok: false; readonly reason: string };

/**
 * The one member gate: a lane receipt at the current `lane/<key>` head, verdict CLEAR. A receipt at an older commit is
 * named as stale rather than missing, because "review again" is the fix for both and the sha says which one happened.
 */
export async function gateMember(d: Deps, key: string): Promise<MemberGate> {
  if (!KEY_RE.test(key)) return { ok: false, reason: `invalid lane key ${key}` };
  const lane = d.store.lane(key);
  if (!lane) return { ok: false, reason: `lane ${key} has no receipt (no such lane)` };
  if (lane.repo === undefined || lane.baseSha === undefined)
    return { ok: false, reason: `lane ${key} has no receipt (it started before the review gate)` };
  const head = asSha(await gitOut(d, lane.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/lane/${key}`]));
  if (head === undefined)
    return { ok: false, reason: `lane ${key}: cannot read refs/heads/lane/${key} in ${lane.repo}` };
  const receipt = d.store.laneReceipt(key, head);
  if (receipt === undefined) {
    const older = d.store.receipts.laneReceipts(key)[0];
    if (older !== undefined)
      return {
        ok: false,
        reason: `lane ${key} has a stale sha: reviewed ${short(older.tip)}, head ${short(head)} (queue it with dori review --lane ${key}, then attest the reviewer verdict)`,
      };
    return {
      ok: false,
      reason: `lane ${key} has no receipt at ${short(head)} (queue it with dori review --lane ${key}, then attest the reviewer verdict)`,
    };
  }
  if (receipt.verdict !== "CLEAR")
    return {
      ok: false,
      reason: `lane ${key} at ${short(head)} is ${receipt.verdict} (queue it with dori review --lane ${key}, then attest the reviewer verdict)`,
    };
  return { ok: true, member: { lane: key, sha: head, verdict: "CLEAR", reviewer: receipt.reviewer } };
}

export function checkedBundle(d: Deps, id: string): Bundle {
  if (!KEY_RE.test(id)) throw new Refusal(`bundle id must match ${KEY_RE}`);
  const bundle = d.store.bundle(id);
  if (bundle === undefined) throw new Refusal(`no bundle ${id}`);
  return bundle;
}

export type OpenOptions = { title: string; repo: string; issue?: number };

export function openBundle(d: Deps, id: string, opts: OpenOptions): Bundle {
  if (!KEY_RE.test(id)) throw new Refusal(`bundle id must match ${KEY_RE}`);
  const existing = d.store.bundle(id);
  if (existing !== undefined) throw new Refusal(`bundle ${id} already exists (${existing.status})`);
  const title = opts.title.trim();
  if (title === "") throw new Refusal("--title must not be empty");
  const bundle: Bundle = {
    id,
    title,
    issue: opts.issue ?? null,
    repo: checkRepo(opts.repo),
    members: [],
    branch: `bundle/${id}`,
    pr: null,
    status: "open",
  };
  d.store.saveBundle(bundle);
  return bundle;
}

/** Adds lanes only when each one's lane receipt is CLEAR at its current branch head; a refused add changes nothing. */
export async function addMembers(d: Deps, id: string, keys: readonly string[]): Promise<Bundle> {
  const bundle = checkedBundle(d, id);
  if (bundle.status === "closed") throw new Refusal(`bundle ${id} is closed; open a new bundle`);
  if (keys.length === 0) throw new Refusal("give at least one lane key");
  const seen = new Set<string>();
  const members = bundle.members.map((m) => ({ ...m }));
  const repo = members
    .map((m) => d.store.lane(m.lane)?.repo)
    .map((p) => (p === undefined ? undefined : repoKey(p)))
    .find((p) => p !== undefined);
  for (const key of keys) {
    if (seen.has(key)) throw new Refusal(`lane ${key} is given twice`);
    seen.add(key);
    const gate = await gateMember(d, key);
    if (!gate.ok) throw new Refusal(`bundle ${id}: ${gate.reason}`);
    if (repo !== undefined) {
      const laneRepo = d.store.lane(key)?.repo;
      if (laneRepo === undefined || repoKey(laneRepo) !== repo)
        throw new Refusal(
          `bundle ${id}: lane ${key} lives in ${laneRepo ?? "no repository"}, not the bundle's ${repo}; one bundle is one checkout`,
        );
    }
    const index = members.findIndex((m) => m.lane === key);
    if (index === -1) members.push(gate.member);
    else members[index] = gate.member;
  }
  bundle.members = members;
  d.store.saveBundle(bundle);
  return bundle;
}

/**
 * The `merge --bundle` path: every recorded member is still CLEAR at the sha it was admitted on, and the bundle names
 * this PR. It checks only the review dimension; checks stay green for both merge paths.
 */
export async function bundleGate(
  d: Deps,
  id: string,
  pr: { repo: string; number: number },
): Promise<string | undefined> {
  const bundle = d.store.bundle(id);
  if (bundle === undefined) return `no bundle ${id}`;
  if (bundle.repo.toLowerCase() !== pr.repo.toLowerCase())
    return `bundle ${id} belongs to ${bundle.repo}, not ${pr.repo}`;
  if (bundle.status === "closed") return `bundle ${id} is closed`;
  if (bundle.pr !== null && bundle.pr.number !== pr.number)
    return `bundle ${id} tracks PR #${bundle.pr.number}, not #${pr.number}`;
  if (bundle.members.length === 0) return `bundle ${id} has no members`;
  const bad: string[] = [];
  for (const m of bundle.members) {
    const gate = await gateMember(d, m.lane);
    if (!gate.ok) {
      bad.push(gate.reason);
      continue;
    }
    if (gate.member.sha !== m.sha)
      bad.push(`lane ${m.lane} moved since it was added (recorded ${short(m.sha)}, head ${short(gate.member.sha)})`);
  }
  return bad.length === 0 ? undefined : `bundle ${id}: members are not all CLEAR: ${bad.join("; ")}`;
}
