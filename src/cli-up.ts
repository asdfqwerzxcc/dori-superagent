import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import { promptsDir, type Deps } from "./harness.ts";
import { reviewLabel } from "./lane-gate.ts";
import { paneWorktreeMismatch } from "./lane-worktree.ts";
import { loopArgs, readLoopCaps } from "./loop-caps.ts";
import { refText } from "./refs.ts";
import { reviewRunLines } from "./review-drain.ts";
import { groupId } from "./runtime/group.ts";
import { openSession, type SessionRef } from "./runtime/types.ts";
import { RuntimeChoiceError } from "./runtime/select.ts";
import { superviseHome, type SupervisedState } from "./supervisor-run.ts";
import { pluginLines } from "./plugins/state.ts";
import { formatEnsureUp, formatSupervised, supervisorHealth } from "./supervisors.ts";
import { unitMode } from "./supervisors/unit-mode.ts";
import { scanWorktrees } from "./worktrees.ts";

const supervisorAlive = (root: string): boolean =>
  supervisorHealth(root).some((h) => h.name === "supervisor" && h.alive);

/**
 * The lead is the pane that answers the human, so it must never hold its turn on a foreground child: the engine
 * promotes one only at its prompt-cache budget (270 s at a 5m TTL) and prints nothing meanwhile, which is why an
 * inbound message queued behind a 5m task call for 5m. On engines that know the marker an omitted
 * `run_in_background` defaults to true while an explicit false still blocks; engines that predate it ignore the
 * variable. Duty and the loops keep the engine default, so only the pane that talks to the human is affected.
 */
const LEAD_ENV = { OMO_TASK_DEFAULT_BACKGROUND: "1" } as const;

const supervise = (d: Deps, startMissing: boolean): Promise<SupervisedState> =>
  d.supervise !== undefined
    ? d.supervise(d.store.root, { startMissing })
    : superviseHome(d.store.root, { startMissing });

/** A registered lead is replaced only when its pane is gone; a probe that fails is doubt, and doubt must not add a second lead. */
type LeadLiveness = "alive" | "unverified" | "gone";

const leadLiveness = async (d: Deps, ref: SessionRef): Promise<LeadLiveness> => {
  try {
    return (await d.runtimes.for(ref).probe(ref)).status === "gone" ? "gone" : "alive";
  } catch {
    return "unverified";
  }
};

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(promptsDir(), name), "utf8").replaceAll("{{dori}}", d.doriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

const ensureLine = (state: SupervisedState): string =>
  state.off ? "off" : state.ensureUp.alive ? `pid=${state.ensureUp.pid ?? "?"}` : "DOWN";

/**
 * Opens lead, duty, the duty loop and the hourly loop on the selected runtime and registers all four roles. herdr: the
 * lead is a new workspace's root pane, duty a tab in it, the loops splits below duty. hc: four terminals labelled with
 * this home's group. When the loops are supervised, their panes are not opened and the stale loop roles are dropped.
 */
export async function up(d: Deps, cwd: string, retireOld = false): Promise<void> {
  const previous = d.store.roles().lead;
  const units = unitMode(d.store.root);
  // A live lead owns the human conversation: opening a second workspace and duty would split it and orphan this one.
  if (!retireOld && previous !== undefined) {
    const liveness = await leadLiveness(d, previous);
    if (liveness !== "gone") {
      // A dead supervisor is the one thing this path must start; an alive one is left exactly as it is.
      await supervise(d, !supervisorAlive(d.store.root));
      console.log(`UP lead ${liveness}; ensuring units only (lead=${refText(previous)}) units=${units}`);
      return;
    }
  }
  const caps = readLoopCaps(d.store.root);
  const rt = d.runtimes.default;
  const env = { DORI_HOME: d.store.root };
  const agent = (name: string) => `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, name))}`;
  // herdr ignores the group of a workspace-root session and reports the new workspace as the lead ref's group.
  const lead = await openSession(
    rt,
    { name: "dori", role: "lead", container: "workspace-root", cwd, env: LEAD_ENV, group: groupId(d.store.root) },
    agent("lead.md"),
  );
  d.store.setRole("lead", lead);
  const group = lead.group;
  const inGroup = group === undefined ? {} : { group };
  const duty = await openSession(
    rt,
    { name: "duty", role: "duty", container: "tab", cwd, env, ...inGroup },
    agent("duty.md"),
  );
  d.store.setRole("duty", duty);
  const retire = async () => {
    if (!retireOld || previous === undefined || previous.id === lead.id) return;
    try {
      await rt.close(previous, "container");
      console.log(`UP retired previous lead ${refText(previous)}`);
    } catch (e) {
      console.log(`UP could not retire ${refText(previous)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (supervisorAlive(d.store.root)) {
    d.store.clearRole("duty-loop");
    d.store.clearRole("hourly-loop");
    console.log("UP loops are supervised; skipping the loop panes (lead+duty only)");
    const state = await supervise(d, false);
    console.log(
      `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loops=supervised ensure-up=${ensureLine(state)} units=${units}`,
    );
    for (const line of formatSupervised(state.health)) console.log(line);
    console.log(formatEnsureUp(state.ensureUp, state.off));
    await retire();
    return;
  }
  const loop = await openSession(
    rt,
    { name: "duty-loop", role: "duty-loop", container: "split-below", near: duty, cwd, env, ...inGroup },
    `${d.doriCmd} duty --interval 60`,
  );
  d.store.setRole("duty-loop", loop);
  const hourlyEnv = rt.kind === "herdr" && group !== undefined ? { ...env, HERDR_WORKSPACE_ID: group } : env;
  const loopCommand = [d.doriCmd, ...loopArgs(caps, ["loop"])].join(" ");
  const hourly = await openSession(
    rt,
    { name: "hourly-loop", role: "hourly-loop", container: "split-below", near: loop, cwd, env: hourlyEnv, ...inGroup },
    loopCommand,
  );
  d.store.setRole("hourly-loop", hourly);
  // Pane mode: the loops are this command's children, so a supervisor must not be started beside them.
  const state = await supervise(d, false);
  console.log(
    `UP runtime=${rt.kind} lead=${refText(lead)} duty=${refText(duty)} loop=${refText(loop)} hourly=${refText(hourly)} home=${d.store.root} units=${units}`,
  );
  console.log(formatEnsureUp(state.ensureUp, state.off));
  await retire();
}

/** The runtime line first (a runtime that cannot be chosen is shown, not thrown; a bad setting still throws). */
function runtimeLine(d: Deps): string {
  try {
    const c = d.choice();
    return `RUNTIME ${c.kind} (from ${c.source})`;
  } catch (e) {
    if (e instanceof RuntimeChoiceError) return `RUNTIME unset: ${e.message}`;
    throw e;
  }
}

/**
 * Runtime, roles with their liveness, the supervised processes and their heartbeats, then the lanes. A role whose pane
 * is gone is printed as STALE, never silently accepted by the next send.
 */
export async function status(d: Deps): Promise<void> {
  console.log(runtimeLine(d));
  const roles = d.store.roles();
  const show = (ref: SessionRef | undefined) => (ref ? refText(ref) : "-");
  console.log(`lead=${show(roles.lead)} duty=${show(roles.duty)} home=${d.store.root}`);
  for (const [role, ref] of Object.entries(roles)) {
    if (ref === undefined) continue;
    try {
      const { status: st } = await d.runtimes.for(ref).probe(ref);
      if (st === "gone") console.log(`STALE ${role}=${refText(ref)}: pane not found`);
    } catch {
      console.log(`UNVERIFIED ${role}=${refText(ref)}: its runtime did not answer`);
    }
  }
  for (const line of formatSupervised(supervisorHealth(d.store.root))) console.log(line);
  for (const line of pluginLines(d.store.root)) console.log(line);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    const review = await reviewLabel(d, l);
    console.log(
      `${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.sessionRef.runtime.padEnd(5)} ${refText(l.sessionRef).padEnd(14)} review=${review.padEnd(10)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`,
    );
    const mismatch = await paneWorktreeMismatch(d, l);
    if (mismatch !== undefined) console.log(`MISMATCH ${l.key}: ${mismatch}`);
  }
  for (const line of reviewRunLines(d)) console.log(line);
  try {
    const { orphans } = await scanWorktrees(d, { dirty: false });
    if (orphans > 0) console.log(`WORKTREES ${orphans} orphan`);
  } catch {
    // The lane table has already printed; a broken worktree root must not hide it.
  }
}
