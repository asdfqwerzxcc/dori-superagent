// One in-place lead revive per pane. A shell that swallowed the typed line, or that still holds a draft, shows the same
// childless tree as a clean prompt, so a second revive into that pane could compose onto the first line. From the second
// attempt `dori up` opens a new lead instead; a different pane starts the count over.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Deps } from "./harness.ts";
import { clearLeadStarting, markLeadStarting } from "./lead-starting.ts";
import { quoteArg } from "./lead-swap-target.ts";
import { emptyPrompt } from "./runtime/pane-liveness.ts";
import { SCREEN_LINES } from "./runtime/screen.ts";
import type { SessionRef } from "./runtime/types.ts";
import { refText } from "./refs.ts";

export const LEAD_REVIVE = "lead-revive.json";

/** The lead env `dori up` sets at creation; a revived pane may not carry it, so the command sets it again. */
export const LEAD_ENV = { OMO_TASK_DEFAULT_BACKGROUND: "1" } as const;

/** How long the second snapshot waits before the proof counts: an agent between exec and fork shows its child by then. */
const CONFIRM_MS = 300;

type ReviveRecord = { readonly pane: string; readonly attempts: number; readonly at: number };

const pathOf = (home: string): string => join(home, "state", LEAD_REVIVE);

const readRecord = (home: string): ReviveRecord | undefined => {
  try {
    const raw = JSON.parse(readFileSync(pathOf(home), "utf8")) as Partial<ReviveRecord>;
    if (typeof raw.pane !== "string" || !Number.isInteger(raw.attempts) || typeof raw.at !== "number") return undefined;
    return { pane: raw.pane, attempts: Math.max(0, raw.attempts as number), at: raw.at };
  } catch {
    return undefined;
  }
};

/** How many times `dori up` has typed the lead into this pane; a pane the record does not name has never been revived. */
export function leadRevives(home: string, pane: string): number {
  const record = readRecord(home);
  return record !== undefined && record.pane === pane ? record.attempts : 0;
}

/** Records one in-place revive of `pane` and returns the new count. A failed write must not stop the revive itself. */
export function markLeadRevived(home: string, pane: string, now: number = Date.now()): number {
  const attempts = leadRevives(home, pane) + 1;
  try {
    mkdirSync(dirname(pathOf(home)), { recursive: true });
    writeFileSync(pathOf(home), JSON.stringify({ pane, attempts, at: now }));
  } catch {
    // The revive proceeds; the next attempt then sees the old count and may type into the pane once more.
  }
  return attempts;
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
 * D2 typing gate: the pane's bottom line is an empty shell prompt (nothing typed into it, nothing redrawn over it), and
 * a second snapshot 300 ms later still shows the childless shell. Anything short of both is refused, and the
 * caller opens a new lead instead of typing.
 */
async function promptProven(d: Deps, ref: SessionRef): Promise<boolean> {
  const rt = d.runtimes.for(ref);
  let screen: string;
  try {
    screen = await rt.read(ref, SCREEN_LINES);
  } catch {
    return false;
  }
  if (!emptyPrompt(screen)) return false;
  await (d.sleep ?? ((ms) => Bun.sleep(ms)))(CONFIRM_MS);
  try {
    return (await rt.probe(ref)).liveness === "exited";
  } catch {
    return false;
  }
}

/**
 * Types the lead command into the pane it already occupies, once ever, at a proven empty prompt, and records the start
 * grace. False, having typed nothing: a previous revive already used this pane, the prompt or the snapshot is unproven,
 * or the snapshot still shows a child.
 */
export async function reviveLeadInPane(d: Deps, ref: SessionRef, command: string): Promise<boolean> {
  const pane = refText(ref);
  if (leadRevives(d.store.root, pane) > 0) return false;
  if (!(await promptProven(d, ref))) return false;
  markLeadRevived(d.store.root, pane);
  markLeadStarting(d.store.root);
  try {
    await d.runtimes.for(ref).start(ref, command);
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
    const { status, liveness } = await d.runtimes.for(ref).probe(ref);
    if (status === "gone") return { liveness: "gone" };
    if (liveness === "doubt") return { liveness: "doubt" };
    return { liveness: status === "shell" ? "shell" : "alive" };
  } catch {
    return { liveness: "unverified" };
  }
}
