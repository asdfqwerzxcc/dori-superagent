import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { prompt, type Deps } from "./harness.ts";
import { laneGate } from "./lane-gate.ts";
import { repoHead, resolveLaneRepo } from "./lane-repo.ts";
import { assertCleanWorktree, createLaneWorktree, discardWorktree, dropLane, landWorktree, paneWorktreeMismatch, rebaseLaneWorktree, worktreeRoot } from "./lane-worktree.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing?.status === "lost")
    throw new Refusal(`lane ${key} is lost; its worktree and branch are kept: dori done --drop ${key} --reason <text>`);
  if (existing && existing.status !== "done" && existing.status !== "dropped")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const repo = await resolveLaneRepo(d, cwd);
  const baseSha = repo === undefined ? undefined : await repoHead(d, repo);
  // A repo we found but cannot read a HEAD from (an empty repository) must not turn into a lane that silently works in
  // the shared checkout: that is exactly the fallback isolation exists to prevent.
  if (repo !== undefined && baseSha === undefined)
    throw new Refusal(
      `cannot read HEAD in ${repo}, so a lane worktree cannot be based on it; the lane was not started and nothing ` +
        `was written to ${repo} (an empty repository needs one commit first)`,
    );
  let worktree: string | undefined;
  if (repo !== undefined && baseSha !== undefined) {
    try {
      worktree = await createLaneWorktree(d, key, repo, baseSha);
    } catch (e) {
      // Isolation is not optional: a lane that cannot get its own tree is refused with the reason, and the main
      // checkout is left exactly as it was. Starting the lane in the shared tree is the one thing we never do.
      if (e instanceof Refusal) throw e;
      const why = e instanceof Error ? e.message : String(e);
      throw new Refusal(
        `cannot create a worktree for lane ${key} under ${worktreeRoot(d)}: ${why}\n` +
          `the lane was not started and nothing was written to ${repo}; fix the reason, then retry: dori start ${key}`,
      );
    }
  }
  const laneCwd = worktree ?? cwd;
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  let ref: SessionRef;
  try {
    await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

    // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
    // workspace stays there); otherwise herdr gets a new "dori" workspace and hc this home's group label.
    const rt = d.runtimes.default;
    const self = d.runtimes.selfAny(process.env);
    const group =
      opts.group ??
      (self?.runtime === rt.kind ? self.group : undefined) ??
      (rt.kind === "herdr" ? await rt.createGroup("dori", laneCwd) : groupId(d.store.root));
    const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
    ref = await openSession(
      rt,
      {
        name: key,
        role: "lane",
        container: "tab",
        cwd: laneCwd,
        env: { DORI_LANE: key, DORI_HOME: d.store.root },
        group,
      },
      `${d.agentCmd} ${shq(kickoff)}`,
    );
  } catch (e) {
    // No pane exists yet, so the tree this start made would only block a retry.
    if (worktree !== undefined && repo !== undefined) await discardWorktree(d, repo, key, worktree);
    throw e;
  }

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.container ?? "",
    brief: briefPath,
    cwd,
    ...(worktree !== undefined ? { worktree } : {}),
    ...(repo !== undefined && baseSha !== undefined ? { repo, baseSha, tipSha: baseSha } : {}),
    status: "working",
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost" || lane.status === "dropped")
    throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(
  d: Deps,
  key: string,
  text: string,
  status?: "working" | "waiting",
): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

export type DoneOptions = {
  /** Remove the worktree and branch without landing, and mark the lane `dropped` with this reason. */
  drop?: string;
  /** Rebase the lane onto the current `main` and re-record its base before gating; a fresh receipt is then required. */
  rebase?: boolean;
};

export async function done(d: Deps, key: string, opts: DoneOptions = {}): Promise<string | undefined> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (opts.drop !== undefined) return dropLane(d, lane, opts.drop);
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
  if (!gate.ok) throw new Refusal(gate.reason);
  // Check cleanliness BEFORE any git mutation: main must never advance while the tree cannot be removed.
  await assertCleanWorktree(d, lane);
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  // Windows refuses `worktree remove` while the pane holds the directory, so close it first.
  if (st !== "gone") await rt.close(lane.sessionRef);
  const landing = lane.worktree === undefined ? undefined : await landWorktree(d, lane);
  const note = gate.note;
  const closed = note === undefined ? "closed by lead" : `closed by lead (${note})`;
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: landing === undefined ? closed : `${closed}; ${landing}` });
  d.store.saveLane(lane);
  return note;
}
