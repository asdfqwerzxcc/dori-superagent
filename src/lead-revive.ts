// One in-place lead revive per pane. A shell that swallowed the typed line, or that still holds a draft, shows the same
// childless tree as a clean prompt, so a second revive into that pane could compose onto the first line. From the second
// attempt `dori up` opens a new lead instead; a different pane starts the count over.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { clearLeadStarting, markLeadStarting } from "./lead-starting.ts";
import { quoteArg } from "./lead-swap-target.ts";
import { emptyPrompt, type PaneLiveness } from "./runtime/pane-liveness.ts";
import { SCREEN_LINES } from "./runtime/screen.ts";
import type { Probe, SessionRef } from "./runtime/types.ts";
import { refText } from "./refs.ts";
import { stateDir } from "./supervisors.ts";

/** One marker file per revived pane under this directory; its existence is the claim. */
export const LEAD_REVIVE = "lead-revives";

/** The lead env `dori up` sets at creation; a revived pane may not carry it, so the command sets it again. */
export const LEAD_ENV = { OMO_TASK_DEFAULT_BACKGROUND: "1" } as const;

/** How long the second look waits before the proof counts: an agent between exec and fork shows its child by then. */
const CONFIRM_MS = 300;
/** Doubt is re-read this many times, this far apart, before it counts: a transient snapshot failure must not split the lead. */
const DOUBT_READS = 3;
const DOUBT_WAIT_MS = 300;

const markerOf = (home: string, pane: string): string =>
  join(stateDir(home), LEAD_REVIVE, `${pane.replace(/[^A-Za-z0-9_.-]/g, "-")}.json`);

/** 1 when `dori up` has already typed the lead into this pane, 0 otherwise (a pane it does not name has never been revived). */
export function leadRevives(home: string, pane: string): number {
  return existsSync(markerOf(home, pane)) ? 1 : 0;
}

/**
 * Claims the one revive of `pane`, or returns false when it is already claimed or the record cannot be written — a
 * failed record must refuse the typing, never fall back to it. The marker is written to a temp name and renamed into
 * place, so a reader never sees half a record and a crash cannot leave a broken claim.
 */
export function claimLeadRevive(home: string, pane: string, now: number = Date.now()): boolean {
  const final = markerOf(home, pane);
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    mkdirSync(join(stateDir(home), LEAD_REVIVE), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ pane, at: now, pid: process.pid }), { flag: "wx" });
    if (existsSync(final)) return false;
    renameSync(tmp, final);
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

/**
 * Re-reads a doubt verdict a few times before it counts. A snapshot that fails once (a busy host, a locked `ps`) must
 * not make a live lead look dead; only the same doubt DOUBT_READS times, DOUBT_WAIT_MS apart, reaches the caller.
 */
export async function settleProbe<T extends { readonly liveness?: PaneLiveness }>(
  probe: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<T> {
  let last = await probe();
  for (let read = 1; read < DOUBT_READS && last.liveness === "doubt"; read++) {
    await sleep(DOUBT_WAIT_MS);
    last = await probe();
  }
  return last;
}

/**
 * The lead command with the requested cwd and the lead env made explicit. `pane run` types into the pane's own shell and
 * keeps its cwd, so a revived pane would otherwise start where the human last moved it, without the non-blocking-turn
 * default the original `dori up` set; PowerShell is herdr's shell on Windows, and POSIX shells take `env`.
 */
export function reviveCommand(agent: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const env = Object.entries(LEAD_ENV);
  if (platform === "win32") {
    const sets = env.map(([k, v]) => `$env:${k} = '${v}'`).join("; ");
    return `Set-Location -LiteralPath ${quoteArg(cwd, platform)}; ${sets}; ${agent}`;
  }
  return `cd ${quoteArg(cwd, platform)} && env ${env.map(([k, v]) => `${k}=${v}`).join(" ")} ${agent}`;
}

/**
 * The pane's bottom line is an empty shell prompt and its tree is a childless shell, read twice CONFIRM_MS apart — the
 * screen again, not only the tree, so a line typed or redrawn during the wait refuses. Returns the confirming snapshot,
 * whose recorded cwd the revive uses; undefined is a refusal.
 */
async function provenPane(d: Deps, ref: SessionRef): Promise<Probe | undefined> {
  const rt = d.runtimes.for(ref);
  const sleep = d.sleep ?? ((ms: number) => Bun.sleep(ms));
  const read = async (): Promise<Probe | undefined> => {
    try {
      const probe = await settleProbe(() => rt.probe(ref), sleep);
      if (probe.liveness !== "exited") return undefined;
      return emptyPrompt(await rt.read(ref, SCREEN_LINES)) ? probe : undefined;
    } catch {
      return undefined;
    }
  };
  if ((await read()) === undefined) return undefined;
  await sleep(CONFIRM_MS);
  return read();
}

/**
 * Types the lead command into the pane it already occupies, once ever, at a proven empty prompt, and records the start
 * grace. False, having typed nothing: the pane was already revived, the prompt or the snapshot is unproven, the claim
 * cannot be written, or the second look shows a child. The command starts in the lead's recorded cwd when the pane
 * reports one, not in whatever cwd the caller happened to run from.
 */
export async function reviveLeadInPane(d: Deps, ref: SessionRef, agent: string, fallbackCwd: string): Promise<boolean> {
  const pane = refText(ref);
  if (leadRevives(d.store.root, pane) > 0) return false;
  const proven = await provenPane(d, ref);
  if (proven === undefined) return false;
  if (!claimLeadRevive(d.store.root, pane)) return false;
  markLeadStarting(d.store.root);
  try {
    await d.runtimes.for(ref).start(ref, reviveCommand(agent, proven.cwd ?? fallbackCwd));
  } catch (e) {
    clearLeadStarting(d.store.root);
    throw e;
  }
  return true;
}

/** A registered lead is kept only when its pane proves a live process; the rest is what `up` does about it. */
export type LeadCheck = { readonly liveness: "alive" | "unverified" | "gone" | "shell" | "doubt" };

export async function leadCheck(d: Deps, ref: SessionRef): Promise<LeadCheck> {
  try {
    const probe = await settleProbe(() => d.runtimes.for(ref).probe(ref), d.sleep ?? ((ms) => Bun.sleep(ms)));
    if (probe.status === "gone") return { liveness: "gone" };
    if (probe.liveness === "doubt") return { liveness: "doubt" };
    return { liveness: probe.status === "shell" ? "shell" : "alive" };
  } catch {
    return { liveness: "unverified" };
  }
}
