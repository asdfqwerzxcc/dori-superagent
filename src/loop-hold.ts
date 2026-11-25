import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { readJson, writeJson } from "./json-file.ts";
import { refText, sameSession } from "./refs.ts";
import type { HostLoad, Lane, LoopRun } from "./store-types.ts";

export { memoryLow } from "./host.ts";

/** What `pull` learned about the starts it could not make; the hold notice reads it after `pull` returns. */
export type PullOutcome = {
  readonly candidates: number;
  readonly waiting: number;
  readonly load: boolean;
  readonly mem: boolean;
  readonly lockLost: boolean;
  readonly host: HostLoad;
};

type HoldState = { readonly key: string; readonly at: number };
const holdPath = (d: Deps): string => join(d.store.root, "state", "loop-hold.json");

/** A lane whose work is on main: closed as done, or READY with its item already marked done by the loop's sync. */
const landed = (d: Deps, lane: Lane): boolean => {
  if (lane.status === "done") return true;
  if (lane.status !== "ready" || lane.item === undefined) return false;
  return d.store.item(lane.item)?.status === "done";
};

/** Roles and the process's own session are off limits: reclaim only ever touches a lane's pane. */
const offLimits = (d: Deps, lane: Lane): boolean => {
  if (Object.values(d.store.roles()).some((ref) => ref !== undefined && sameSession(ref, lane.sessionRef))) return true;
  const self = d.runtimes.selfAny(process.env);
  return self !== undefined && sameSession(self, lane.sessionRef);
};

async function closeLandedLanes(d: Deps, closed: string[], failed: string[]): Promise<void> {
  for (const listed of d.store.lanes()) {
    if (listed.migration === true || !landed(d, listed) || offLimits(d, listed)) continue;
    try {
      const { status } = await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
      if (status !== "idle") continue;
      // The probe is async: re-read and re-prove everything before closing.
      const lane = d.store.lane(listed.key);
      if (lane === undefined || lane.migration === true || !landed(d, lane) || offLimits(d, lane)) continue;
      if (!sameSession(lane.sessionRef, listed.sessionRef)) continue;
      await d.runtimes.for(lane.sessionRef).close(lane.sessionRef);
      closed.push(`closed landed lane ${lane.key} (${refText(lane.sessionRef)} was idle)`);
    } catch (e) {
      failed.push(`lane ${listed.key}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
}

/**
 * Close what a memory hold may safely lose, then report what changed and how much memory came back. Runs only when
 * the loop is about to skip a start for low memory. A live review is never touched: its age says nothing about whether
 * it is still doing useful work.
 */
export async function reclaimMemory(d: Deps, run: LoopRun): Promise<void> {
  const before = d.host();
  const closed: string[] = [];
  const failed: string[] = [];
  await closeLandedLanes(d, closed, failed);
  const after = d.host();
  run.reclaimed ??= [];
  run.reclaimed.push(
    `memory reclaim: closed ${closed.length} landed lane(s), failed ${failed.length}; ` +
      `mem free ${before.memFreePct}% (${before.memFreeMb} MB) -> ${after.memFreePct}% (${after.memFreeMb} MB)`,
  );
  run.reclaimed.push(...closed, ...failed);
}

export type HoldNotice = { readonly key: string; readonly text: string };

const stamp = (at: number): string => `${new Date(at).toISOString().slice(0, 16)}Z`;

/**
 * The run's one hold notice: only when no lane started, candidates are waiting, and a host limit or a lost lock is
 * why. Repeats of the same cause are suppressed by the state file, so a long hold wakes the lead once.
 */
export function holdNotice(run: LoopRun, pulled: PullOutcome, interval: number): HoldNotice | undefined {
  if (run.started.length > 0 || pulled.candidates === 0) return undefined;
  const causes = [
    ...(pulled.mem ? ["mem"] : []),
    ...(pulled.load ? ["load"] : []),
    ...(pulled.lockLost ? ["lock"] : []),
  ];
  if (causes.length === 0) return undefined;
  const reasons = run.held
    .filter((line) => !line.includes("item(s) waiting"))
    .join("; ")
    .replace(/, mem free \d+% \(\d+ MB\)/g, "");
  const text =
    `[HOLD ${stamp(run.at)}] ${reasons || "host busy"} | mem free ${pulled.host.memFreePct}% ` +
    `(${pulled.host.memFreeMb} MB) | ${pulled.waiting} item(s) waiting | next try ` +
    `${stamp(run.at + interval)}`;
  return { key: causes.join("+"), text };
}

export type HoldDelivery = { readonly state: "sent" | "suppressed" | "failed"; readonly why?: string };

/** Send `notice` unless the same cause was already sent; a failed delivery leaves the state unset so it is retried. */
export async function notifyHold(d: Deps, notice: HoldNotice): Promise<HoldDelivery> {
  let previous: HoldState | undefined;
  try {
    previous = readJson<HoldState>(holdPath(d));
  } catch {
    previous = undefined;
  }
  if (previous?.key === notice.key) return { state: "suppressed" };
  try {
    if ((await tellLead(d, notice.text, "loop")) === undefined) return { state: "failed", why: "no live lead" };
  } catch (e) {
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e);
    return { state: "failed", why };
  }
  writeJson(holdPath(d), { key: notice.key, at: d.now() });
  return { state: "sent" };
}

export const clearHold = (d: Deps): void => rmSync(holdPath(d), { force: true });
