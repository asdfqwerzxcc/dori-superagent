import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { declaredRepoMismatch, repoHintFromBrief, repoMismatch } from "./brief-repo.ts";
import { shq } from "./delivery.ts";
import { prompt, type Deps } from "./harness.ts";
import { repoHead, resolveLaneRepo } from "./lane-repo.ts";
import { createLaneWorktree, discardWorktree, worktreeRoot } from "./lane-worktree.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";
import { CEILING_VARS } from "./worker-limits.ts";

/** @public The type pruneLaneRecords returns; kept at its pre-split import path. */
export type { PruneResult } from "./lane-prune.ts";
export { pruneLaneRecords } from "./lane-prune.ts";

/** @public The options dori done accepts; kept at its pre-split import path. */
export type { DoneOptions } from "./lane-close.ts";
export { done } from "./lane-close.ts";

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; repo?: string; group?: string; item?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing?.status === "lost")
    throw new Refusal(`lane ${key} is lost; its worktree and branch are kept: dori done --drop ${key} --reason <text>`);
  if (existing && existing.status !== "done" && existing.status !== "dropped")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  // A lane opened for a backlog item records the link, so closing it closes the item even when the keys differ. Only a
  // live item is linked: a lane reusing the key of a finished item is ordinary ad-hoc work.
  const linkedId = opts.item ?? key;
  const linkedItem = d.store.item(linkedId);
  const item =
    linkedItem !== undefined && (linkedItem.status === "open" || linkedItem.status === "running")
      ? linkedId
      : undefined;
  const hinted = repoHintFromBrief(briefFile);
  const cwd = resolve(opts.cwd ?? opts.repo ?? hinted ?? process.cwd());
  // Checked before anything is written or opened: a missing brief was a raw ENOENT, and a missing cwd went on to the runtime.
  if (!existsSync(briefFile)) throw new Refusal(`no brief file ${briefFile}`);
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Refusal(`no directory ${cwd}`);
  const repo = await resolveLaneRepo(d, cwd);
  // A design or omo-stats brief must not be lifted into another checkout: refuse before a worktree or brief is written.
  const briefText = readFileSync(briefFile, "utf8");
  const declared = opts.repo ?? hinted;
  const mismatch = declared !== undefined ? declaredRepoMismatch(declared, cwd) : repoMismatch(briefText, repo ?? cwd);
  if (mismatch !== undefined) throw new Refusal(mismatch);
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
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd, ...CEILING_VARS });
  let ref: SessionRef;
  try {
    await Bun.write(briefPath, `${briefText.trimEnd()}\n\n${footer}`);

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
    ...(item !== undefined ? { item } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(repo !== undefined && baseSha !== undefined ? { repo, baseSha, tipSha: baseSha } : {}),
    status: "working",
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane, { revive: true });
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
  // A recorded READY is the lane's final word: a report that arrives afterwards is an addendum and never lowers the
  // status, so a message queued before the READY was sent cannot block `dori done`.
  const reopened = lane.status !== "ready";
  if (reopened) {
    if (status) lane.status = status;
    else if (lane.demotedAt !== undefined) lane.status = "working";
  }
  delete lane.demotedAt;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${reopened && status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  // --evidence "$PR_URL" with PR_URL unset would mark the lane ready on an empty link.
  if (evidence.some((e) => !e.trim())) throw new Refusal("READY --evidence is empty: give a PR, a receipt or a file");
  // --evidence "$PR_URL" with PR_URL unset would mark the lane ready on an empty link.
  if (evidence.some((e) => !e.trim())) throw new Refusal("READY --evidence is empty: give a PR, a receipt or a file");
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
