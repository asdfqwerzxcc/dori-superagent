// The lead restart: drain, kill the pane's lead tree, wait for a shell, type the relaunch, and prove a new pid+engine.

import { existsSync } from "node:fs";
import { failureDetail } from "./delivery.ts";
import { insideLeadTree, type LeadSwapPlan } from "./lead-swap-detach.ts";
import { buildLeadCommand, matchLeadStack, newestSession } from "./lead-swap-target.ts";
import { refText } from "./refs.ts";
import type { Probe, SessionRef } from "./runtime/types.ts";
import type { Proc } from "./lead-process-list.ts";

export type LeadSwapResult = {
  readonly code: number;
  readonly outcome: "dry-run" | "restarted" | "delegated" | "failed";
  readonly reason?: string;
  readonly target?: readonly number[];
  readonly newPid?: number;
};

export type LeadSwapOptions = {
  readonly pane: SessionRef;
  readonly agentCmd: string;
  readonly session?: string;
  readonly promptPath?: string;
  readonly sessionsRoot: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  /** Wait this long for the live lead to reach idle/done before killing it; `force` skips the wait. */
  readonly drainMs: number;
  readonly deathMs: number;
  readonly launchMs: number;
  readonly pollMs: number;
  readonly platform: NodeJS.Platform;
  /** Test seams for the in-tree decision; `delegate` starts the swap outside the tree when it is inside. */
  readonly selfPid?: number;
  readonly delegate?: (plan: LeadSwapPlan) => Promise<{ readonly pid: number }>;
  readonly selfInPane?: boolean;
  readonly list: () => Promise<readonly Proc[] | undefined>;
  readonly probe: () => Promise<Probe>;
  readonly kill: (pid: number) => Promise<void>;
  readonly typeShell: (text: string) => Promise<boolean>;
  readonly version: () => Promise<string | undefined>;
  readonly runtimeBuild: () => string | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
};

export async function runLeadSwap(opts: LeadSwapOptions): Promise<LeadSwapResult> {
  const fail = (reason: string): LeadSwapResult => {
    opts.log(`LEADSWAP FAILED ${reason}`);
    return { code: 1, outcome: "failed", reason };
  };
  // The start line is first and durable: the incident log had only `drain` left.
  opts.log(`LEADSWAP start pane=${refText(opts.pane)} session=${opts.session ?? "auto"} drain=${opts.drainMs}`);
  let first: Probe;
  try {
    first = await opts.probe();
  } catch (e) {
    return fail(`cannot read pane ${refText(opts.pane)}: ${failureDetail(e)}`);
  }
  if (first.status === "gone") return fail(`pane ${refText(opts.pane)} is gone`);

  let procs: readonly Proc[] | undefined;
  try {
    procs = await opts.list();
  } catch {
    procs = undefined;
  }
  if (procs === undefined) return fail("the process list could not be read");
  const stack = matchLeadStack(procs, first.rootPid, opts.promptPath);
  if (stack.roots.length === 0) {
    const looked = opts.promptPath === undefined ? "omo.js" : `omo.js or ${opts.promptPath}`;
    return fail(`no lead process under pane ${refText(opts.pane)} (looked for ${looked})`);
  }
  // A prompt-path match with no pane root can name several panes' leads; killing all of them is not a restart.
  if (first.rootPid === undefined && stack.roots.length > 1) {
    return fail(
      `pane ${refText(opts.pane)} has no root pid and ${stack.roots.length} lead stacks matched; refusing to guess`,
    );
  }

  const oldPids = new Set(stack.matched.map((p) => p.pid));
  const session = opts.session ?? stack.session ?? newestSession(opts.sessionsRoot, first.cwd ?? "", opts.now());
  if (session === undefined) return fail("no session file to resume; pass --session <file>");
  if (/\.jsonl$/i.test(session) && !existsSync(session)) return fail(`session file not found: ${session}`);
  const prompt = stack.prompt ?? opts.promptPath;
  if (prompt === undefined || prompt === "")
    return fail(
      "no lead prompt found: the lead's command has no --append-system-prompt and the rendered prompt is missing",
    );
  if (!existsSync(prompt)) return fail(`lead prompt not found: ${prompt}`);
  const command = buildLeadCommand(opts.agentCmd, session, prompt, opts.platform);
  const target = stack.roots.map((p) => p.pid);
  const engine = await opts.version();
  const runtime = opts.runtimeBuild();

  if (opts.dryRun) {
    opts.log(
      `LEADSWAP dry-run pane=${refText(opts.pane)} status=${first.status} target=${target.join(",")} matched=${[
        ...oldPids,
      ].join(",")} session=${session} engine=${engine ?? "unknown"} runtime=${runtime ?? "unknown"}`,
    );
    opts.log(`LEADSWAP command ${command}`);
    return { code: 0, outcome: "dry-run", target };
  }

  const plan: LeadSwapPlan = {
    pane: opts.pane,
    session,
    prompt,
    command,
    target,
    matched: [...oldPids],
    drainMs: opts.drainMs,
    force: opts.force,
  };
  // An in-tree swap would kill itself with the lead: hand the restart to a worker outside the tree and kill nothing here.
  if (
    opts.delegate !== undefined &&
    (opts.selfInPane === true || insideLeadTree(procs, oldPids, opts.selfPid ?? process.pid))
  ) {
    try {
      const started = await opts.delegate(plan);
      opts.log(
        `LEADSWAP delegated pid=${started.pid} pane=${refText(opts.pane)} session=${session} target=${target.join(",")}`,
      );
      return { code: 0, outcome: "delegated", target };
    } catch (e) {
      return fail(`could not start the out-of-tree swap: ${failureDetail(e)}`);
    }
  }

  if (!opts.force) {
    opts.log(`LEADSWAP drain pane=${refText(opts.pane)} status=${first.status}`);
    const deadline = opts.now() + opts.drainMs;
    let status: string = first.status;
    while (status !== "idle" && status !== "done") {
      if (opts.now() >= deadline)
        return fail(`lead is still ${status} after ${opts.drainMs}ms; pass --force to kill it`);
      await opts.sleep(opts.pollMs);
      try {
        status = (await opts.probe()).status;
      } catch {
        // A failed probe during the drain is doubt, not a reason to kill: keep waiting until the deadline.
      }
    }
  }

  for (const pid of target) {
    try {
      await opts.kill(pid);
    } catch (e) {
      return fail(`could not kill pid ${pid}: ${failureDetail(e)}`);
    }
    opts.log(`LEADSWAP killed ${pid} (tree)`);
  }
  await opts.sleep(1000);

  // The safety gate: the pane must report no agent and none of the old lead processes may still answer. Text typed
  // into a live TUI becomes a user prompt, so a live agent here aborts the restart instead of typing.
  const deathDeadline = opts.now() + opts.deathMs;
  for (;;) {
    let status = "unknown";
    let alive: number[] = [...oldPids];
    try {
      status = (await opts.probe()).status;
    } catch {
      // Unknown status is doubt: keep waiting, never type.
    }
    try {
      const rows = await opts.list();
      if (rows !== undefined) alive = rows.filter((r) => oldPids.has(r.pid)).map((r) => r.pid);
    } catch {
      // Keep the old pids as alive when the list cannot be read.
    }
    if (status === "shell" && alive.length === 0) break;
    if (opts.now() >= deathDeadline) {
      const pids = alive.length === 0 ? "" : `, pids=${alive.join(",")}`;
      return fail(`pane still has a live agent after the kill (status=${status}${pids}); nothing was typed`);
    }
    await opts.sleep(opts.pollMs);
  }

  let before: Probe;
  try {
    before = await opts.probe();
  } catch (e) {
    return fail(`cannot re-read pane before typing: ${failureDetail(e)}`);
  }
  if (before.status !== "shell") return fail(`pane is ${before.status}, not a shell; nothing was typed`);
  try {
    const fresh = await opts.list();
    if (fresh === undefined || fresh.some((r) => oldPids.has(r.pid))) {
      return fail("a lead process is still alive in the pane; nothing was typed");
    }
  } catch {
    return fail("the process list could not be re-read before typing; nothing was typed");
  }

  let typed: boolean;
  try {
    typed = await opts.typeShell(command);
  } catch (e) {
    return fail(`typing the relaunch failed: ${failureDetail(e)}`);
  }
  if (!typed) return fail("the pane is not a bare shell; nothing was typed");
  opts.log(`LEADSWAP typed ${command}`);

  const launchDeadline = opts.now() + opts.launchMs;
  let launched: Proc | undefined;
  for (;;) {
    try {
      const rows = await opts.list();
      if (rows !== undefined) {
        launched = matchLeadStack(rows, before.rootPid, prompt).roots.find((p) => !oldPids.has(p.pid));
      }
    } catch {
      // The list is re-read on the next tick.
    }
    if (launched !== undefined) break;
    if (opts.now() >= launchDeadline) break;
    await opts.sleep(opts.pollMs);
  }
  if (launched === undefined) {
    return fail("no new lead process appeared; the session was not relaunched (nothing more was typed)");
  }

  const verifiedEngine = await opts.version();
  if (verifiedEngine === undefined) {
    return fail(
      `new lead pid=${launched.pid} started, but the engine version could not be read; not reporting success`,
    );
  }
  const verifiedRuntime = opts.runtimeBuild();
  if (verifiedRuntime === undefined) {
    return fail(
      `new lead pid=${launched.pid} started, but its runtime directory could not be read; not reporting success`,
    );
  }
  let status = "";
  try {
    status = (await opts.probe()).status;
  } catch {
    status = "unknown";
  }
  opts.log(
    `LEADSWAP RESTARTED pane=${refText(opts.pane)} pid=${launched.pid} session=${session} engine=${verifiedEngine} runtime=${verifiedRuntime} status=${status}`,
  );
  return { code: 0, outcome: "restarted", target, newPid: launched.pid };
}
