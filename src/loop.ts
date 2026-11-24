// The hourly loop: sync the backlog with live lanes, audit for missed work, start the next item
// that needs no decision, ask the lead the open questions, and record the run. It never merges,
// never pushes and never edits a lane record; under a memory hold it may close an idle landed lane's
// session (see loop-hold.ts). See docs/hourly-loop.md.
import { log, MAX_ATTEMPTS } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import { tellLead } from "./inbox.ts";
import { startLane } from "./lanes.ts";
import { audit, HOUR } from "./loop-audit.ts";
import { DEFAULT_MAX_LANES, DEFAULT_MAX_STARTS } from "./loop-caps.ts";
import { clearHold, holdNotice, memoryLow, notifyHold, reclaimMemory, type PullOutcome } from "./loop-hold.ts";
import { acquire, holds, release } from "./loop-lock.ts";
import { rememberQuiet, worthTelling } from "./loop-quiet.ts";
import { sync } from "./loop-sync.ts";
import { refText } from "./refs.ts";
import type { LoopRun } from "./store-types.ts";

export { HOUR };
export { MAX_ATTEMPTS };
export const REMIND_HOURS = 6;

export type LoopOpts = { interval?: number; maxLanes?: number; maxStarts?: number; maxLoad?: number; force?: boolean };

const isOpenLane = (status: string): boolean => status !== "done" && status !== "lost" && status !== "dropped";

async function pull(
  d: Deps,
  run: LoopRun,
  maxLanes: number,
  maxStarts: number,
  maxLoad: number | undefined,
  nonce: string,
): Promise<PullOutcome> {
  const host = d.host();
  const lanes = d.store.lanes().filter((l) => isOpenLane(l.status));
  const open = lanes.length;
  const served = new Set(lanes.map((l) => l.item ?? l.key));
  const candidates = d.store
    .items()
    .filter((i) => i.status === "open" && !i.decision && !served.has(i.id))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const base: PullOutcome = {
    candidates: candidates.length,
    waiting: candidates.length,
    load: false,
    mem: false,
    lockLost: false,
    host,
  };
  if (!d.store.roles().lead) {
    run.held.push("no lead pane registered");
    return base;
  }
  let starts = Math.max(0, Math.min(maxLanes - open, maxStarts));
  let current = host;
  let mem = false;
  let load = false;
  if (candidates.length > 0 && starts > 0) {
    if (memoryLow(current)) {
      await reclaimMemory(d, run);
      current = d.host();
    }
    mem = memoryLow(current);
    load = current.load1 > (maxLoad ?? current.cores);
    if (load || mem) {
      run.held.push(
        `host busy: load ${current.load1.toFixed(1)} (limit ${maxLoad ?? current.cores}), mem free ${current.memFreePct}% (${current.memFreeMb} MB)`,
      );
      starts = 0;
    }
  }
  // Each start attempt uses one of this run's slots, so a broken host costs at most `starts` failures per run.
  // A failed item counts toward MAX_ATTEMPTS and then becomes a question, so it never blocks the items behind it.
  let tried = 0;
  let lockLost = false;
  for (; tried < Math.min(starts, candidates.length); tried++) {
    const item = candidates[tried]!;
    if (!holds(d, nonce)) {
      run.held.push("lock lost to another loop; no more starts this run");
      lockLost = true;
      break;
    }
    try {
      await startLane(d, item.id, item.brief, { cwd: item.cwd, item: item.id });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const lane = d.store.lane(item.id);
      if (!lane || !isOpenLane(lane.status) || lane.createdAt < run.at) {
        item.startFailures = (item.startFailures ?? 0) + 1;
        if (item.startFailures >= MAX_ATTEMPTS)
          item.decision = `lane start failed ${item.startFailures} times (${why.slice(0, 120)}); fix the brief or cwd, or drop?`;
        log(d, item, "start", `failed: ${why}`);
        run.findings.push(`start ${item.id} failed: ${why}`);
        continue;
      }
      run.findings.push(`${item.id} started in ${refText(lane.sessionRef)} but the lead was not told: ${why}`);
    }
    item.status = "running";
    log(d, item, "start", "lane opened by the hourly loop");
    run.started.push(`${item.id} (p${item.priority})`);
  }
  const waiting = candidates.length - tried;
  if (waiting > 0) {
    run.held.push(
      `${waiting} item(s) waiting: ${Math.max(0, maxLanes - open - run.started.length)} free of ${maxLanes} lanes, max ${maxStarts}/run`,
    );
  }
  return { ...base, waiting, load, mem, lockLost, host: current };
}

function ask(d: Deps, run: LoopRun): void {
  const now = d.now();
  for (const item of d.store.items()) {
    if (item.status !== "open" || !item.decision) continue;
    const line = `[DECIDE ${item.id}] ${item.decision} -> dori backlog decide ${item.id} --text '...' | dori backlog drop ${item.id}`;
    if (item.askedAt === undefined) {
      item.askedAt = now;
      log(d, item, "ask", item.decision);
      run.asked.push(line);
    } else if (item.remindedAt === undefined && now - item.askedAt >= REMIND_HOURS * HOUR) {
      item.remindedAt = now;
      log(d, item, "remind", item.decision);
      run.asked.push(`(reminder) ${line}`);
    }
  }
}

export function summary(run: LoopRun): string {
  if (run.skipped) return `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] skipped: ${run.skipped}`;
  const s = run.status!;
  const lines = [
    `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] lanes ${s.lanes}/${s.maxLanes}${s.adhoc.length ? ` (not from backlog: ${s.adhoc.join(", ")})` : ""}` +
      ` | items open ${s.items.open} (decide ${s.items.decide}) running ${s.items.running}` +
      ` | load ${s.host.load1.toFixed(1)}/${s.host.cores} mem-free ${s.host.memFreePct}%`,
  ];
  for (const k of ["synced", "findings", "started", "held"] as const)
    if (run[k].length) lines.push(`${k}: ${run[k].join("; ")}`);
  if (run.reclaimed?.length) lines.push(`reclaimed: ${run.reclaimed.join("; ")}`);
  lines.push(...run.asked);
  return lines.join("\n");
}

/** One hourly pass. Skipped runs (stopped, locked, too soon) change nothing and write nothing. */
export async function loopTick(d: Deps, opts: LoopOpts = {}): Promise<LoopRun> {
  const interval = opts.interval ?? HOUR;
  const maxLanes = opts.maxLanes ?? DEFAULT_MAX_LANES;
  const maxStarts = opts.maxStarts ?? DEFAULT_MAX_STARTS;
  const empty = { synced: [], findings: [], started: [], held: [], asked: [] };
  const stop = d.store.stop();
  if (stop) return { at: d.now(), skipped: `stopped: ${stop.reason}`, ...empty };
  const lock = acquire(d);
  if ("holder" in lock) return { at: d.now(), skipped: lock.holder, ...empty };
  try {
    const last = d.store.lastRun();
    if (last && !opts.force && d.now() - last.at < interval) {
      return { at: d.now(), skipped: `ran ${Math.floor((d.now() - last.at) / 60_000)}m ago`, ...empty };
    }
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [], reclaimed: [] };
    const reconciled = await sync(d, run);
    await audit(d, run);
    const pulled = await pull(d, run, maxLanes, maxStarts, opts.maxLoad, lock.nonce);
    ask(d, run);
    // A stale running item resolved by sync is reported, not just listed: the operator may need to fix why the lane
    // vanished. Appended after pull so a start failure keeps its place as the run's first finding.
    for (const event of reconciled) if (event.kind === "reopen") run.findings.push(event.text);
    const items = d.store.items();
    const running = new Set(items.filter((i) => i.status === "running").map((i) => i.id));
    const lanes = d.store.lanes().filter((l) => isOpenLane(l.status));
    run.status = {
      lanes: lanes.length,
      maxLanes,
      adhoc: lanes.filter((l) => !running.has(l.item ?? l.key)).map((l) => l.key),
      items: {
        open: items.filter((i) => i.status === "open").length,
        decide: items.filter((i) => i.status === "open" && i.decision).length,
        running: running.size,
      },
      host: d.host(),
    };
    const hold = holdNotice(run, pulled, interval);
    if (hold === undefined) clearHold(d);
    else {
      const sent = await notifyHold(d, hold);
      if (sent.state === "sent") run.findings.push(`hold notified: ${hold.key}`);
      else if (sent.state === "failed")
        run.findings.push(`hold notification failed: ${hold.key} (${sent.why ?? "unknown"})`);
    }
    const record = d.store.saveRun(run);
    try {
      if (await worthTelling(d, run)) {
        await tellLead(d, summary(run), "loop");
        await rememberQuiet(d, run);
      }
    } catch (e) {
      run.findings.push(`report to the lead failed: ${e instanceof Error ? e.message : String(e)}`);
      d.store.saveRun(run, record);
    }
    return run;
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * How long to sleep: until the last stamp's next hour when that is still ahead (so runs keep their cadence after a
 * restart), otherwise a full interval. A stopped, locked-out or failing loop writes no stamp, so it waits an interval
 * between checks instead of spinning.
 */
export function msUntilNext(d: Deps, interval: number): number {
  const last = d.store.lastRun();
  const due = last ? last.at + interval - d.now() : 0;
  return due > 0 ? Math.max(1000, due) : interval;
}
