import type { Deps } from "./harness.ts";
import { nextWatch, observe, watched, WORKING_STALE_MS } from "./lane-watch.ts";
import type { Lane } from "./store-types.ts";

/**
 * The pane's word is a hint: a lane record can keep saying `working` long after its pane went quiet. Output and files
 * are the evidence, and a working lane whose evidence stopped moving for WORKING_STALE_MS is demoted to `waiting`.
 * Returns true when it was demoted. With no readable signal, a pane that says working counts as activity (as before)
 * and an idle one is left alone, so its idle minutes still accumulate for the nudges. `demotedAt` keeps the lane on the
 * nudge/escalation path: only an agent that reported `waiting` itself is left alone.
 */
export async function settleWorking(d: Deps, lane: Lane, paneWorking: boolean, now: number): Promise<boolean> {
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
