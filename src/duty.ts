import { DeliveryUncertain, failureDetail } from "./delivery.ts";
import { type Deps, prompt } from "./harness.ts";
import { runHook } from "./hooks.ts";
import { flushInbox, sendOrThrow, tellLead } from "./inbox.ts";
import { nextWatch, observe, WORKING_STALE_MS } from "./lane-watch.ts";
import { Refusal } from "./refusal.ts";
import { refText, sameSession } from "./refs.ts";
import { drainReviewQueue } from "./review-queue.ts";
import type { Lane } from "./store-types.ts";

export const NUDGE_MINUTES = [10, 20, 40] as const;

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** An open lane the duty loop watches; a lane being migrated is left alone (no nudge, no lost, no activity stamp). */
const watched = (lane: Lane): boolean =>
  (lane.status === "working" || lane.status === "waiting") && lane.migration !== true;

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
        // back — neither a registered role nor a live (not done) lane. A pane that is merely restarting
        // still has its lane, so its queue is kept.
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
      if (st === "blocked" || st === "error") continue;
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
  // Review requests last: the drain only reports and expires them, so it can never hold a nudge or a LOST notice.
  try {
    events.push(...(await drainReviewQueue(d)));
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
  });
  return events;
}

/**
 * The pane's word is a hint: a lane record can keep saying `working` long after its pane went quiet. Output and files
 * are the evidence, and a working lane whose evidence stopped moving for WORKING_STALE_MS is demoted to `waiting`.
 * Returns true when it was demoted. With no readable signal, a pane that says working counts as activity (as before)
 * and an idle one is left alone, so its idle minutes still accumulate for the nudges. `demotedAt` keeps the lane on the
 * nudge/escalation path: only an agent that reported `waiting` itself is left alone.
 */
async function settleWorking(d: Deps, lane: Lane, paneWorking: boolean, now: number): Promise<boolean> {
  const seen = await observe(d, lane);
  // The read is async: a report, a READY or a migration may have landed meanwhile, and must not be overwritten.
  const current = d.store.lane(lane.key);
  if (
    current === undefined ||
    current.status !== "working" ||
    !watched(current) ||
    current.sessionRef.id !== lane.sessionRef.id ||
    current.lastActivityAt !== lane.lastActivityAt ||
    current.watch?.at !== lane.watch?.at
  )
    return false;
  const next = nextWatch(current, seen, now);
  if (next === undefined) {
    if (!paneWorking) return false;
    current.lastActivityAt = now;
    d.store.saveLane(current);
    return false;
  }
  if (next.moved || current.watch === undefined) {
    current.watch = next.watch;
    if (next.moved) current.lastActivityAt = now;
    d.store.saveLane(current);
    return false;
  }
  if (now - Math.max(next.watch.at, current.lastActivityAt) < WORKING_STALE_MS) return false;
  current.status = "waiting";
  current.demotedAt = now;
  delete current.watch;
  current.log.push({
    at: now,
    kind: "demoted",
    text: `no pane output or file change for ${WORKING_STALE_MS / 60_000} min`,
  });
  d.store.saveLane(current);
  return true;
}
