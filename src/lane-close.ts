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

type Landed = { readonly repo: string; readonly sha: string; readonly via: string };

/**
 * Proof that the lane's work is on main: a branch whose tip is already in it (or whose tree is, after a squash merge),
 * else - when the branch is gone, as a PR landing deletes its remote half - the newest reviewed tip with a CLEAR
 * receipt that main contains. A surviving branch with commits main never got is not landed, whatever older receipts say.
 * A surviving branch main contains is proof on ancestry alone: its merge already happened outside this close, so the
 * verdict on its tip can no longer stop it. Only the gone-branch path needs a CLEAR receipt to know what landed.
 */
async function landedState(d: Deps, lane: Lane, allowContent: boolean): Promise<Landed | undefined> {
  const repo = lane.repo;
  if (repo === undefined) return undefined;
  const branch = branchOf(lane.key);
  const ref = await d.exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const branchTip = ref.code === 0 ? ref.stdout.trim() : undefined;
  if (branchTip !== undefined && branchTip !== "") {
    if ((await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", branchTip, "HEAD"])).code === 0)
      return { repo, sha: branchTip, via: `${branch}@${branchTip.slice(0, 12)} is already on main` };
    if (allowContent && (await d.exec("git", ["-C", repo, "diff", "--quiet", branchTip, "HEAD"])).code === 0)
      return { repo, sha: branchTip, via: `${branch}@${branchTip.slice(0, 12)} matches main by content (squash)` };
    return undefined;
  }
  const newest = d.store.receipts.laneReceipts(lane.key)[0];
  const sha = newest?.tip ?? lane.tipSha;
  if (sha === undefined || (await laneReceiptFor(d, lane, sha))?.verdict !== "CLEAR") return undefined;
  if ((await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", sha, "HEAD"])).code !== 0) return undefined;
  return { repo, sha, via: `${sha.slice(0, 12)} is already on main (CLEAR receipt lane_${lane.key}@${sha})` };
}

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
  // The fallback receipt proves reviewed work landed; it never authorizes publishing commits main does not hold.
  const alreadyLanded = gate.via === undefined ? undefined : await landedState(d, lane, true);
  if (gate.via !== undefined && alreadyLanded === undefined)
    throw new Refusal(
      `lane ${key}: ${gate.via}, but ${branchOf(key)} is not on main: done does not publish commits that receipt ` +
        `does not cover. Move the follow-up work to a new lane, or drop this one: dori done --drop ${key} --reason <text>`,
    );
  // Check cleanliness BEFORE any git mutation: main must never advance while the tree cannot be removed.
  await assertCleanWorktree(d, lane);
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  // A landed lane may still run a follow-up turn; closing it must not wait for that work. An unlanded lane keeps the
  // old rule: a busy pane is writing the very commits done would tear down.
  let paneNote: string | undefined;
  if (st === "working" || st === "blocked" || st === "error") {
    const landed = alreadyLanded ?? (await landedState(d, lane, true));
    if (landed === undefined) throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
    paneNote = `pane was ${st} on a landed lane: ${landed.via}`;
  }
  // Windows refuses `worktree remove` while the pane holds the directory, so close it first.
  if (st !== "gone") await rt.close(lane.sessionRef);
  // Read the gate's own tip: it is the commit the receipt decision proved, even when a rebase moved HEAD past it.
  const tip = lane.baseSha === undefined ? undefined : (gate.tip ?? (await laneHead(d, lane)) ?? lane.tipSha);
  const receipt = gate.receipt ?? (tip === undefined ? undefined : await laneReceiptFor(d, lane, tip));
  // An exact-tip receipt (no gate.via) covers what landWorktree publishes: the worktree is created on lane/<key>, so
  // its branch is that tip. A fallback was guarded above; a detached HEAD is outside the lane contract.
  const landing = lane.worktree === undefined ? undefined : await landWorktree(d, lane);
  const notes = [gate.note, gate.via, paneNote].filter((n): n is string => n !== undefined);
  const note = notes.length === 0 ? undefined : notes.join("; ");
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
        : gate.via !== undefined
          ? ` (${gate.via})`
          : ` (${receipt.verdict} receipt lane_${key}@${receipt.tip}${receipt.tip === tip ? "" : ", same patch"})`;
    closeItemForLane(d, latest, "done", `lane ${key} done at ${tip.slice(0, 12)}${covered}`);
  } else closeItemForLane(d, latest, "done", `lane ${key} done`);
  return note;
}

/** Closes a lane whose worktree is already gone, without landing anything: only when a commit proves the work is on
 * main (see landedState, ancestry only: a surviving branch with extra commits is not a squash just because its tree
 * matches). The branch and its worktree registration are removed, so a retry under the same key starts clean. */
async function closeMissingWorktree(d: Deps, lane: Lane): Promise<string> {
  const path = lane.worktree ?? "(none)";
  const proof = await landedState(d, lane, false);
  if (proof === undefined)
    throw new Refusal(
      `lane ${lane.key}: its worktree ${path} is gone and nothing proves the lane landed: lane/${lane.key} is not on ` +
        `main, and a recorded tip without a CLEAR receipt is not proof either. The lane is not closed; restore the ` +
        `checkout and run dori done ${lane.key} again, or abandon it with dori done --drop ${lane.key} --reason <text>`,
    );
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  // The work is on main and the checkout is gone, so a pane still running follow-up work is no reason to keep the record.
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
  const pane = st === "gone" ? "" : `; pane was ${st}`;
  const closed = `closed by lead (worktree ${path} is gone; ${proof.via}${pane})`;
  latest.status = "done";
  latest.log.push({ at: d.now(), kind: "done", text: closed });
  d.store.saveLane(latest);
  closeItemForLane(d, latest, "done", `lane ${lane.key} done at ${proof.sha.slice(0, 12)} (already landed)`);
  return closed;
}
