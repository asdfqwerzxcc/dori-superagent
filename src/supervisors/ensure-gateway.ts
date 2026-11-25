import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAllProcesses, type Proc } from "../lead-process-list.ts";
import { pidAlive, terminateProcess } from "../process-liveness.ts";
import { spawnExec } from "../runtime/exec.ts";
import { recordedAlive, recordedChildren, spawnDetached, type RecordedChild } from "../supervisor-run.ts";
import { ageMs, entryFor, freshSince, heartbeatPath, supervisorRecord } from "../supervisors.ts";

// The `DoriGatewayGuard` scheduled task runs this every minute as the cover for "the watchdog itself died". A stale
// supervisor heartbeat means the whole always-on half is gone, so the guard ends the supervisor tree and starts one
// supervisor. The tree is both the OS subtree below every supervisor process and every pid the supervisor, plugin and
// ensure-up records name: a unit in pane mode is a child of its pane shell, not of the supervisor, and a parent-only
// kill left those units running (duplicate ensure-up 22836/8904 on 2026-11-24). Nothing descends from a recorded unit.
/** Four missed 30 s beats: the old guard's window, kept so a slow host does not churn the stack. */
const STALE_MS = 120_000;
/** How long a killed pid may take to leave the OS, in polls of 250 ms. */
const KILL_TRIES = 20;
const POLL_MS = 250;
/** How long a new supervisor may take to write its first beat, in polls of 250 ms. */
const BEAT_TRIES = 40;
const canon = (path: string): string =>
  process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;

/** The entries a command-line scan can match: the home's shim and this checkout's own program. */
export function supervisorEntries(home: string): string[] {
  return [join(home, "bin", "supervisor.ts"), join(import.meta.dir, "supervisor.ts")];
}

/** Every pid whose command line runs one of `entries`: duplicates included, which the record alone cannot see. */
export function supervisorPids(procs: readonly Proc[], entries: readonly string[]): number[] {
  const wanted = entries.map(canon);
  return [...new Set(procs.filter((p) => wanted.some((e) => canon(p.command).includes(e))).map((p) => p.pid))];
}

/** Each pid's distance below the roots (0 = root), walking parent links once. */
function depths(roots: readonly number[], procs: readonly Proc[]): Map<number, number> {
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (p.parent === undefined) continue;
    const list = children.get(p.parent);
    if (list === undefined) children.set(p.parent, [p.pid]);
    else list.push(p.pid);
  }
  const depth = new Map<number, number>();
  const queue: Array<readonly [number, number]> = roots.map((pid) => [pid, 0]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [pid, d] = next;
    if (depth.has(pid)) continue;
    depth.set(pid, d);
    for (const child of children.get(pid) ?? []) queue.push([child, d + 1]);
  }
  return depth;
}

/** This process and every process above it: a kill never reaches the pane that runs the guard. */
function selfChain(procs: readonly Proc[]): number[] {
  const parent = new Map<number, number>();
  for (const p of procs) if (p.parent !== undefined) parent.set(p.pid, p.parent);
  const chain = [process.pid];
  for (let pid = parent.get(process.pid); pid !== undefined && !chain.includes(pid); pid = parent.get(pid)) {
    chain.push(pid);
  }
  return chain;
}

export type KillPlan = { readonly supervisors: readonly number[]; readonly order: readonly number[] };

/**
 * Children before parents: the supervisor's subtree by depth, every recorded unit and plugin at depth 1. The plan always
 * carries the children of the pids it names, so there is no parent-only path.
 */
export function killPlan(
  supervisors: readonly number[],
  procs: readonly Proc[],
  recorded: readonly number[],
  protect: readonly number[],
): KillPlan {
  const banned = new Set(protect);
  const roots = supervisors.filter((pid) => !banned.has(pid));
  const depth = depths(roots, procs);
  for (const pid of recorded) if (!depth.has(pid) && !banned.has(pid)) depth.set(pid, 1);
  const order = [...depth]
    .filter(([pid]) => !banned.has(pid))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([pid]) => pid);
  return { supervisors: roots, order };
}

export type GuardAction = "healthy" | "restarted" | "refused";

export type GuardOutcome = {
  readonly action: GuardAction;
  readonly fresh: boolean;
  readonly supervisors: readonly number[];
  readonly killed: readonly number[];
  readonly survivors: readonly number[];
  readonly spawned?: number;
  readonly beat: boolean;
  readonly lines: readonly string[];
};

/** What the guard reads and acts with; tests replace every one so no real process is scanned or killed. */
export type GuardOptions = {
  readonly now?: () => number;
  readonly procs?: () => Promise<readonly Proc[] | undefined>;
  readonly alive?: (pid: number) => boolean;
  readonly recordedAlive?: (child: RecordedChild) => boolean;
  readonly kill?: (pid: number) => boolean;
  readonly spawn?: (entry: string, cwd: string) => number | undefined;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly protect?: readonly number[];
  readonly staleMs?: number;
  readonly killTries?: number;
  readonly beatTries?: number;
};

/**
 * Kills the supervisor tree when its heartbeat is stale and starts one supervisor again; a fresh beat under a live
 * record leaves everything alone. The process list is read (one hidden call) only when the record cannot prove a live
 * supervisor, so the normal minute costs a file read and one kernel32 liveness probe. The kill line is logged before the
 * first kill and the survivor line after the last one; a survivor refuses the restart, because a new supervisor over a
 * live unit duplicates it.
 */
export async function ensureGateway(home: string, opts: GuardOptions = {}): Promise<GuardOutcome> {
  const now = opts.now ?? Date.now;
  const alive = opts.alive ?? pidAlive;
  const childAlive = opts.recordedAlive ?? recordedAlive;
  const kill = opts.kill ?? terminateProcess;
  const spawn = opts.spawn ?? ((entry, cwd) => spawnDetached(entry, cwd));
  const scan = opts.procs ?? (() => listAllProcesses(spawnExec));
  const sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    opts.log?.(line);
  };
  const beat = heartbeatPath(home, "supervisor");
  const fresh = (ageMs(beat, now()) ?? Infinity) < (opts.staleMs ?? STALE_MS);
  const record = supervisorRecord(home, "supervisor");
  const recordLive =
    record !== undefined && record.pid !== process.pid && childAlive({ pid: record.pid, at: record.startedAt });

  if (fresh && recordLive) {
    const line = `GUARD HEALTHY supervisor=${record?.pid ?? -1} fresh=1`;
    emit(line);
    return {
      action: "healthy",
      fresh,
      supervisors: [record?.pid ?? -1],
      killed: [],
      survivors: [],
      beat: true,
      lines,
    };
  }

  const procs = (await scan()) ?? [];
  if (procs.length === 0) emit("GUARD SCAN unavailable=1 records_only=1");
  const found = supervisorPids(procs, supervisorEntries(home));
  // The record is one supervisor; a duplicate the record alone cannot see makes the stack ambiguous, so it is killed.
  if (fresh && found.length === 1) {
    emit(`GUARD HEALTHY supervisor=${found[0]} fresh=1 scan=1`);
    return {
      action: "healthy",
      fresh,
      supervisors: found,
      killed: [],
      survivors: [],
      beat: true,
      lines,
    };
  }

  const roots = [...new Set([...found, ...(recordLive && record !== undefined ? [record.pid] : [])])];
  const recorded = recordedChildren(home)
    .filter(childAlive)
    .map((child) => child.pid);
  const plan = killPlan(roots, procs, recorded, [...(opts.protect ?? []), ...selfChain(procs)]);
  if (plan.order.length > 0) {
    emit(
      `GUARD KILL fresh=${fresh ? 1 : 0} supervisors=${plan.supervisors.join(",") || "-"} tree=${plan.order.join(",")}`,
    );
  }
  for (const pid of plan.order) kill(pid);
  const waitDead = async (pids: readonly number[]): Promise<number[]> => {
    let left = pids.filter(alive);
    for (let i = 0; i < (opts.killTries ?? KILL_TRIES) && left.length > 0; i++) {
      await sleep(POLL_MS);
      left = left.filter(alive);
    }
    return left;
  };
  let left = plan.order.length > 0 ? await waitDead(plan.order) : [];
  if (left.length > 0) {
    // A child the supervisor restarted between the scan and the kill gets one more pass.
    for (const pid of left) kill(pid);
    left = await waitDead(left);
  }
  if (plan.order.length > 0) {
    emit(`GUARD SURVIVORS pids=${left.join(",") || "none"} killed=${plan.order.length - left.length}`);
  }
  if (left.length > 0) {
    // Starting a supervisor over a survivor would duplicate the unit the survivor holds; the next minute retries.
    emit(`GUARD START skipped=1 survivors=${left.join(",")}`);
    return { action: "refused", fresh, supervisors: roots, killed: plan.order, survivors: left, beat: false, lines };
  }

  const entry = entryFor(home, "supervisor");
  const since = now();
  const spawned = spawn(entry, home);
  emit(`GUARD RESTART supervisor=${spawned ?? "?"} killed=${plan.order.length}`);
  let beats = freshSince(beat, since);
  for (let i = 0; i < (opts.beatTries ?? BEAT_TRIES) && !beats; i++) {
    await sleep(POLL_MS);
    beats = freshSince(beat, since);
  }
  emit(`GUARD BEAT supervisor=${spawned ?? "?"} fresh=${beats ? 1 : 0}`);
  return {
    action: "restarted",
    fresh,
    supervisors: roots,
    killed: plan.order,
    survivors: [],
    ...(spawned === undefined ? {} : { spawned }),
    beat: beats,
    lines,
  };
}

/** The guard as the scheduled task runs it: one line per step, and every line except the healthy one kept in a log. */
export async function runEnsureGateway(home = process.env["DORI_HOME"] ?? join(homedir(), ".dori")): Promise<number> {
  const logPath = join(home, "state", "ensure-gateway.log");
  const outcome = await ensureGateway(home, {
    log: (line) => {
      console.log(line);
      if (line.startsWith("GUARD HEALTHY")) return;
      try {
        mkdirSync(join(home, "state"), { recursive: true });
        appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
      } catch {}
    },
  });
  return outcome.action === "healthy" || (outcome.action === "restarted" && outcome.beat) ? 0 : 1;
}

if (import.meta.main) process.exit(await runEnsureGateway());
