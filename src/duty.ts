import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import { type Deps, prompt } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox, sendOrThrow, tellLead } from "./inbox.ts";
import { settleWorking } from "./lane-settle.ts";
import { WORKING_STALE_MS, watched } from "./lane-watch.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import { drainReviewQueue } from "./review-queue.ts";
import { drainReviewRuns } from "./review-drain.ts";

export const NUDGE_MINUTES = [10, 20, 40] as const;

/** A lead inbox that has waited this long is one the pane cannot take: warn the lead once per batch. */
const INBOX_WAIT_WARN_MS = 5 * 60_000;
const warnedLeadWaits = new Set<string>();

/**
 * How long a pane may sit in `blocked` or `error` before the duty loop tells the lead. The first nudge is the duty
 * loop's first reaction to an idle lane, so the same ten minutes is its first reaction to a stall nobody is watching.
 */
const STUCK_MINUTES = NUDGE_MINUTES[0];

export type DutyEvent = { lane?: string; pane?: string; pr?: string; action: string; detail?: string };

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const ref of d.store.inboxPanes()) {
    const paneId = refText(ref);
    try {
      const result = await flushInbox(d, ref);
      // flushInbox follows a `.forward` marker; the counts are read where the entries live now.
      const at = d.store.forwardOf(ref) ?? ref;
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "queued") await warnWaitingLead(d, ref, events);
      if (result === "no-agent") {
        events.push({
          pane: paneId,
          action: "inbox-held",
          detail: `no agent in front; ${d.store.queued(at).length} message(s) kept`,
        });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(at).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) {
        // A closed lane's pane keeps its inbox forever otherwise: the loop retries the same entry every
        // pass and the log fills with inbox-target-gone. Drop it only when the target can never come
        // back — neither a registered role nor a live lane (`laneBySession` skips done, dropped and lost). A pane
        // that is merely restarting still has its lane, so its queue is kept.
        const isRole = Object.values(d.store.roles()).some((r) => sameSession(r, ref));
        if (isRole || d.store.laneBySession(ref) !== undefined) {
          events.push({ pane: paneId, action: "inbox-target-gone" });
        } else {
          const dropped = d.store.queued(ref).length;
          d.store.saveInbox(ref, []);
          events.push({ pane: paneId, action: "inbox-dropped", detail: `${dropped} message(s) for a closed target` });
        }
      } else if (e instanceof DeliveryUncertain && !e.typed)
        events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const listed of d.store.lanes()) {
    if (!watched(listed)) continue;
    try {
      const { status: st } = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      // Re-read right before deciding and saving: a report, a READY or a migration may have landed during the probe.
      let lane = d.store.lane(listed.key);
      if (lane === undefined || !watched(lane) || lane.sessionRef.id !== listed.sessionRef.id) continue;
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        void runHook(d, "onLost", { key: lane.key, text: "pane disappeared without READY", evidence: "" });
        await tellLead(d, `[LOST ${lane.key}] pane ${refText(lane.sessionRef)} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      // Any status but blocked/error ends the stall, so a later one is reported again.
      const endsStall = st !== "blocked" && st !== "error" && lane.blockedSince !== undefined;
      if (endsStall) {
        delete lane.blockedSince;
        delete lane.blockedAlerted;
        d.store.saveLane(lane);
      }
      // A pane resting in blocked/error wants a person. Nothing is typed into it, so nothing would ever move it;
      // the lead hears about it once per stall, after STUCK_MINUTES, and never for a lane that already said WAITING.
      // Checked before the inactivity demotion: a pane that cannot take input is a stall, not a silent lane.
      if (st === "blocked" || st === "error") {
        if (lane.status === "waiting" && lane.demotedAt === undefined) continue;
        if (lane.blockedSince === undefined) {
          lane.blockedSince = now;
          d.store.saveLane(lane);
        }
        const stalledMin = Math.floor((now - lane.blockedSince) / 60_000);
        if (lane.blockedAlerted === true || stalledMin < STUCK_MINUTES) continue;
        lane.blockedAlerted = true;
        lane.log.push({ at: now, kind: "stuck", text: `${st} for ${stalledMin} min` });
        d.store.saveLane(lane);
        await tellLead(
          d,
          `[STUCK ${lane.key}] ${refText(lane.sessionRef)} has been ${st} for ${stalledMin} min and needs a person`,
          "duty",
        );
        events.push({ lane: lane.key, action: "stuck" });
        continue;
      }
      if (lane.status === "working") {
        if (await settleWorking(d, lane, st === "working", now)) {
          events.push({
            lane: lane.key,
            action: "demoted",
            detail: `no output or file change for ${WORKING_STALE_MS / 60_000} min`,
          });
          continue;
        }
        const reread = d.store.lane(lane.key);
        if (reread === undefined || !watched(reread) || reread.sessionRef.id !== lane.sessionRef.id) continue;
        lane = reread;
      }
      if (lane.status === "waiting" && lane.demotedAt === undefined) continue;
      if (st === "working" && lane.demotedAt === undefined) continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(
          d,
          lane.key,
          prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }),
          "duty",
        );
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(
          d,
          `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`,
          "duty",
        );
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: listed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  // Review queues last: their drains only read records and report, so they never hold a nudge or a LOST notice.
  try {
    events.push(...(await drainReviewQueue(d)));
    events.push(...(await drainReviewRuns(d)));
  } catch (e) {
    // A queue that cannot be read must not end the loop for the panes and lanes handled above.
    events.push({ action: "review-queue-failed", detail: failureDetail(e) });
  }
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
    stuck: count((a) => a === "stuck"),
  });
  return events;
}

/**
 * A lead inbox that stayed queued past the threshold is one the pane cannot take (blocked, a dialog, a failed read).
 * The hold reason is already on stderr; this warns the lead once per oldest message, so a stuck inbox is never silent
 * (r-extra3). The notice itself queues in the same inbox and is delivered with the batch.
 */
async function warnWaitingLead(d: Deps, ref: SessionRef, events: DutyEvent[]): Promise<void> {
  const lead = d.store.roles().lead;
  if (lead === undefined || !sameSession(lead, ref)) return;
  const queued = d.store.queued(ref);
  const oldest = queued.reduce((min, m) => Math.min(min, m.at), Number.POSITIVE_INFINITY);
  const waited = d.now() - oldest;
  if (queued.length === 0 || waited < INBOX_WAIT_WARN_MS) return;
  const key = `${d.store.root}|${refText(ref)}|${oldest}`;
  if (warnedLeadWaits.has(key)) return;
  warnedLeadWaits.add(key);
  const minutes = Math.floor(waited / 60_000);
  const status = await d.runtimes
    .for(ref)
    .probe(ref)
    .then((p) => p.status)
    .catch(() => "unknown" as const);
  await tellLead(
    d,
    `[INBOX-WAIT lead] ${queued.length} message(s) waiting ${minutes}m (pane ${status}); see the duty log for the hold reason`,
    "duty",
  );
  events.push({
    pane: refText(ref),
    action: "inbox-wait",
    detail: `${queued.length} message(s) waiting ${minutes}m; pane ${status}; lead warned once`,
  });
}
