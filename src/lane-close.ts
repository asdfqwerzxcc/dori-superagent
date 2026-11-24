// `dori done`: land or drop one lane and record the close.

import { closeItemForLane } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { laneGate } from "./lane-gate.ts";
import { laneHead } from "./lane-repo.ts";
import {
  assertCleanWorktree,
  dropLane,
  landWorktree,
  paneWorktreeMismatch,
  rebaseLaneWorktree,
} from "./lane-worktree.ts";
import { Refusal } from "./refusal.ts";
import type { Lane } from "./store-types.ts";

export type DoneOptions = {
  /** Remove the worktree and branch without landing, and mark the lane `dropped` with this reason. */
  drop?: string;
  /** Rebase the lane onto the current `main` and re-record its base before gating; a fresh receipt is then required. */
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
    const receipt = d.store.laneReceipt(key, tip);
    closeItemForLane(
      d,
      latest,
      "done",
      `lane ${key} done at ${tip.slice(0, 12)}${receipt === undefined ? "" : ` (${receipt.verdict} receipt lane_${key}@${tip})`}`,
    );
  } else closeItemForLane(d, latest, "done", `lane ${key} done`);
  return note;
}

/**
 * Closes a lane whose worktree is already gone, without landing anything: only when the lane's recorded tip is an
 * ancestor of the repository's HEAD, so the reviewed work is provably published. A checkout that is merely missing is
 * not proof of a landing; that lane is refused with both ways out named.
 */
async function closeMissingWorktree(d: Deps, lane: Lane): Promise<string> {
  const path = lane.worktree ?? "(none)";
  const repo = lane.repo;
  const tip = lane.tipSha;
  const landed =
    repo !== undefined && tip !== undefined
      ? (await d.exec("git", ["-C", repo, "merge-base", "--is-ancestor", tip, "HEAD"])).code === 0
      : false;
  if (!landed || tip === undefined)
    throw new Refusal(
      `lane ${lane.key}: its worktree ${path} is gone or unreadable and its recorded tip ` +
        `${tip?.slice(0, 12) ?? "(none)"} is not on main, so the work cannot be proven landed; restore the checkout and ` +
        `run dori done ${lane.key} again, or close the record with dori done --drop ${lane.key} --reason <text>`,
    );
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${lane.key} pane is ${st}; let it finish first`);
  if (st !== "gone") await rt.close(lane.sessionRef);
  const latest = d.store.lane(lane.key) ?? lane;
  const closed = `closed by lead (worktree ${path} is gone; ${tip.slice(0, 12)} is already on main)`;
  latest.status = "done";
  latest.log.push({ at: d.now(), kind: "done", text: closed });
  d.store.saveLane(latest);
  closeItemForLane(d, latest, "done", `lane ${lane.key} done at ${tip.slice(0, 12)} (already landed)`);
  return closed;
}
