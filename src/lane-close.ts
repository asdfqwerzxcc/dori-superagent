// `dori done`: land or drop one lane and record the close.

import { closeItemForLane } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { laneGate } from "./lane-gate.ts";
import { laneReceiptFor } from "./lane-patch.ts";
import { laneHead } from "./lane-repo.ts";
import {
  assertCleanWorktree,
  branchOf,
  dropLane,
  landWorktree,
  paneWorktreeMismatch,
  rebaseLaneWorktree,
  teardownTolerated,
} from "./lane-worktree.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";
import type { Lane } from "./store-types.ts";

const gitWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `git exited ${r.code}`;

export type DoneOptions = {
  /** Remove the worktree and branch without landing, and mark the lane `dropped` with this reason. */
  drop?: string;
  /** Rebase the lane onto the current `main` and re-record its base before gating; the receipt covers it only if the patch-id matches. */
  rebase?: boolean;
};

export async function done(d: Deps, key: string, opts: DoneOptions = {}): Promise<string | undefined> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (opts.drop !== undefined) {
    // Dropping a live lane abandons its work, so the item it served is dropped too. A lost lane is only a record the
    // loop already reopened: dropping it clears the key for a retry and must leave that open item alone.
    const live = lane.status === "working" || lane.status === "waiting" || lane.status === "ready";
    const result = await dropLane(d, lane, opts.drop);
    if (live) closeItemForLane(d, lane, "dropped", `lane ${key} dropped: ${opts.drop.trim()}`);
    return result;
  }
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  // A pane that runs outside its own worktree commits into the shared checkout; landing it would publish exactly the
  // commits isolation cannot vouch for.
  const mismatch = await paneWorktreeMismatch(d, lane);
  if (mismatch !== undefined)
    throw new Refusal(
      `lane ${key}: ${mismatch}; its commits cannot be attributed to the lane worktree. Move the pane into the ` +
        `worktree, or drop the lane: dori done --drop ${key} --reason <text>`,
    );
  if (opts.rebase === true) {
    const before = lane.baseSha;
    const rebased = await rebaseLaneWorktree(d, lane);
    if (rebased !== before) d.store.saveLane(lane);
  }
  const gate = await laneGate(d, lane);
  // A worktree git can no longer read (removed by a close, or by hand) still closes normally when its tip is on main:
  // nothing would land, so the receipt gate has nothing left to decide.
  if (!gate.ok) {
    if (gate.headUnreadable === true) return closeMissingWorktree(d, lane);
    throw new Refusal(gate.reason);
  }
  // Check cleanliness BEFORE any git mutation: main must never advance while the tree cannot be removed.
  await assertCleanWorktree(d, lane);
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  // Windows refuses `worktree remove` while the pane holds the directory, so close it first.
  if (st !== "gone") await rt.close(lane.sessionRef);
  // The gate proved this tip carries the CLEAR receipt (or that the lane committed nothing); read it before landing
  // removes the worktree, so the item's log can name the commit and receipt that closed it.
  const tip = lane.baseSha === undefined ? undefined : ((await laneHead(d, lane)) ?? lane.tipSha);
  const receipt = tip === undefined ? undefined : await laneReceiptFor(d, lane, tip);
  const landing = lane.worktree === undefined ? undefined : await landWorktree(d, lane);
  const note = gate.note;
  const closed = note === undefined ? "closed by lead" : `closed by lead (${note})`;
  // Re-read before the close is recorded: a report or a READY may have landed while the lane was being landed, and its
  // log entries must survive this write.
  const latest = d.store.lane(key) ?? lane;
  latest.status = "done";
  latest.log.push({ at: d.now(), kind: "done", text: landing === undefined ? closed : `${closed}; ${landing}` });
  d.store.saveLane(latest);
  if (tip !== undefined) {
    const covered =
      receipt === undefined
        ? ""
        : ` (${receipt.verdict} receipt lane_${key}@${receipt.tip}${receipt.tip === tip ? "" : ", same patch"})`;
    closeItemForLane(d, latest, "done", `lane ${key} done at ${tip.slice(0, 12)}${covered}`);
  } else closeItemForLane(d, latest, "done", `lane ${key} done`);
  return note;
}

/**
 * The commit that proves the lane landed, or undefined when nothing proves it. A surviving `lane/<key>` is the truth:
 * its own head must be on main, because the recorded tip is only the commit the last review pinned and lags behind any
 * commit made after that review. With the branch already gone, the recorded tip plus its CLEAR receipt is the proof
 * (the ordinary landed close deletes the branch, and the receipt was written before the merge).
 */
async function landedProof(d: Deps, lane: Lane): Promise<{ readonly repo: string; readonly sha: string } | undefined> {
  const repo = lane.repo;
  if (repo === undefined) return undefined;
  const branch = branchOf(lane.key);
  const ref = await d.exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const branchTip = ref.code === 0 ? ref.stdout.trim() : undefined;
  const sha = branchTip === undefined || branchTip === "" ? lane.tipSha : branchTip;
  if (sha === undefined) return undefined;
  if ((branchTip === undefined || branchTip === "") && (await laneReceiptFor(d, lane, sha))?.verdict !== "CLEAR")
    return undefined;
  const ancestor = await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", sha, "HEAD"]);
  return ancestor.code === 0 ? { repo, sha } : undefined;
}

/**
 * Closes a lane whose worktree is already gone, without landing anything: only when a commit proves the work is on
 * main (see landedProof). The branch and its worktree registration are removed, so a retry under the same key starts
 * clean. A checkout that is merely missing is not proof of a landing; that lane is refused with both ways out named.
 */
async function closeMissingWorktree(d: Deps, lane: Lane): Promise<string> {
  const path = lane.worktree ?? "(none)";
  const proof = await landedProof(d, lane);
  if (proof === undefined)
    throw new Refusal(
      `lane ${lane.key}: its worktree ${path} is gone and nothing proves the lane landed: lane/${lane.key} is not on ` +
        `main, and a recorded tip without a CLEAR receipt is not proof either. The lane is not closed; restore the ` +
        `checkout and run dori done ${lane.key} again, or abandon it with dori done --drop ${lane.key} --reason <text>`,
    );
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${lane.key} pane is ${st}; let it finish first`);
  if (lane.worktree !== undefined) {
    const unlock = await d.exec("git", ["-C", proof.repo, "worktree", "unlock", lane.worktree]);
    if (!teardownTolerated("unlock", unlock.code, unlock.stderr))
      throw new Refusal(`lane ${lane.key}: cannot unlock ${lane.worktree}: ${gitWhy(unlock)}; the lane is not closed`);
  }
  const prune = await d.exec("git", ["-C", proof.repo, "worktree", "prune"]);
  if (prune.code !== 0)
    throw new Refusal(
      `lane ${lane.key}: cannot prune worktrees in ${proof.repo}: ${gitWhy(prune)}; the lane is not closed`,
    );
  const del = await d.exec("git", ["-C", proof.repo, "branch", "-D", branchOf(lane.key)]);
  if (del.code !== 0 && !/not found|no such branch/i.test(`${del.stderr}${del.stdout}`))
    throw new Refusal(`lane ${lane.key}: cannot delete ${branchOf(lane.key)}: ${gitWhy(del)}; the lane is not closed`);
  if (st !== "gone") await rt.close(lane.sessionRef);
  const latest = d.store.lane(lane.key) ?? lane;
  const closed = `closed by lead (worktree ${path} is gone; ${proof.sha.slice(0, 12)} is already on main)`;
  latest.status = "done";
  latest.log.push({ at: d.now(), kind: "done", text: closed });
  d.store.saveLane(latest);
  closeItemForLane(d, latest, "done", `lane ${lane.key} done at ${proof.sha.slice(0, 12)} (already landed)`);
  return closed;
}
