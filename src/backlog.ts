import { appendFileSync } from "node:fs";
import { backlogAdd, log } from "./backlog-item.ts";
import { KEY_RE, type Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import type { Item, Lane } from "./store-types.ts";

export { backlogAdd, log };

function knownItem(d: Deps, id: string): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE}`);
  const item = d.store.item(id);
  if (!item) throw new Refusal(`no backlog item ${id}`);
  return item;
}

function openItem(d: Deps, id: string): Item {
  const item = knownItem(d, id);
  if (item.status !== "open") throw new Refusal(`item ${id} is ${item.status}, not open`);
  return item;
}

/** A lane that is still working (or ready to close); closed and lost records no longer hold an item. */
const laneAlive = (status: Lane["status"]): boolean => status !== "done" && status !== "lost" && status !== "dropped";

/**
 * The newest lane that serves `itemId`: the lane record's explicit `item` link, or the key an older record started
 * under (the item id was always that key before the link existed). Newest wins so a restart supersedes a stale record.
 */
export function laneForItem(d: Deps, itemId: string): Lane | undefined {
  return d.store
    .lanes()
    .filter((l) => l.item === itemId || (l.item === undefined && l.key === itemId))
    .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))[0];
}

/**
 * Closes the backlog item a lane was serving: `done` when the lane landed, `dropped` when its work was abandoned. An
 * item already closed keeps its outcome, a newer lane for the same item owns its state, and a lane older than the item
 * (the id was re-added) says nothing about the new work, so none of those are overwritten here.
 */
export function closeItemForLane(d: Deps, lane: Lane, outcome: "done" | "dropped", text: string): boolean {
  const id = lane.item ?? (d.store.item(lane.key) !== undefined ? lane.key : undefined);
  if (id === undefined) return false;
  const item = d.store.item(id);
  if (!item || item.status === "done" || item.status === "dropped") return false;
  if (lane.createdAt < item.createdAt) return false;
  const other = d.store
    .lanes()
    .find(
      (l) => l.key !== lane.key && laneAlive(l.status) && (l.item === id || (l.item === undefined && l.key === id)),
    );
  if (other !== undefined) return false;
  item.status = outcome;
  log(d, item, outcome === "done" ? "done" : "drop", text);
  return true;
}

/** A failed item counts toward this many attempts and then becomes a question, so it never blocks the queue. */
export const MAX_ATTEMPTS = 2;

export type ReconcileEvent = { id: string; kind: "done" | "reopen"; text: string };

/**
 * Lane-driven item transitions: an open or running item whose lane landed becomes done; a running item whose lane
 * vanished, was lost or was dropped becomes open again (an open item is already where it belongs). `countAttempts` is
 * false on read paths (listing must not inflate attempts); the hourly loop passes true so a repeatedly failing item
 * turns into a decision. A lane older than the item is ignored: the id was re-added after that lane closed.
 */
export function reconcileRunningItems(d: Deps, opts: { countAttempts: boolean }): ReconcileEvent[] {
  const events: ReconcileEvent[] = [];
  for (const item of d.store.items()) {
    const lane = laneForItem(d, item.id);
    const landed = lane?.status === "done" && lane.createdAt >= item.createdAt;
    if (item.status === "open" && landed) {
      item.status = "done";
      log(d, item, "done", "lane done");
      events.push({ id: item.id, kind: "done", text: `${item.id} done (lane done)` });
      continue;
    }
    if (item.status !== "running") continue;
    if (landed) {
      item.status = "done";
      log(d, item, "done", "lane done");
      events.push({ id: item.id, kind: "done", text: `${item.id} done (lane done)` });
      continue;
    }
    if (lane && lane.status !== "lost" && lane.status !== "dropped") continue;
    const why = lane ? `lane ${lane.status}` : "lane record missing";
    item.status = "open";
    if (opts.countAttempts) {
      item.attempts += 1;
      if (item.attempts >= MAX_ATTEMPTS) item.decision = `${why} ${item.attempts} times; retry, re-brief or drop?`;
    }
    log(d, item, "reopen", opts.countAttempts ? `${why}, attempt ${item.attempts}` : why);
    events.push({
      id: item.id,
      kind: "reopen",
      text: opts.countAttempts
        ? `${item.id} reopened (${why}, attempt ${item.attempts})`
        : `${item.id} reopened (${why})`,
    });
  }
  return events;
}

/** Records the human's answer: clears the decision and appends the answer to the item's brief. */
export function backlogDecide(d: Deps, id: string, answer: string): void {
  if (!answer.trim()) throw new Refusal("decide needs the answer text");
  const item = openItem(d, id);
  appendFileSync(item.brief, `\n\nDecision on "${item.decision ?? "(none)"}": ${answer.trim()}\n`);
  delete item.decision;
  delete item.askedAt;
  delete item.remindedAt;
  item.attempts = 0;
  item.startFailures = 0;
  log(d, item, "decide", answer);
}

export function backlogDrop(d: Deps, id: string, why = "dropped"): void {
  const item = knownItem(d, id);
  // A lane that finished or was dropped leaves the item at "running" until the loop reconciles it, so the guard asks
  // the lane store instead of trusting the flag: only a lane still working or waiting keeps the item from closing.
  if (item.status === "running") {
    const lane = laneForItem(d, id);
    if (lane !== undefined && (lane.status === "working" || lane.status === "waiting"))
      throw new Refusal(`item ${id} is running as a lane; close the lane first`);
  }
  item.status = "dropped";
  log(d, item, "drop", why);
}

/** Re-exported so existing callers keep importing the issue import feature from this module. */
export { backlogImport, IMPORT_LIMIT, importId } from "./backlog-import.ts";
