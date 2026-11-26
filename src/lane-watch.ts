// Tells a lane that is really working from one whose record only still says `working`: pane output and checkout
// changes are the evidence, and a working lane whose evidence stopped moving is demoted by the duty loop.

import { createHash } from "node:crypto";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "./harness.ts";
import type { Lane, LaneWatch } from "./store-types.ts";

/** A `working` lane with no new pane output and no file change for this long is demoted to `waiting`. */
export const WORKING_STALE_MS = 5 * 60_000;

/** An open lane the duty loop watches; a lane being migrated is left alone (no nudge, no lost, no activity stamp). */
export const watched = (lane: Lane): boolean =>
  (lane.status === "working" || lane.status === "waiting") && lane.migration !== true;

const SCREEN_LINES = 40;
const WALK_LIMIT = 4_000;
const SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
  ".turbo",
]);

export type Seen = { readonly screen?: string; readonly files?: string };

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

const INPUT = /^❯/;
const RULE = /^─{10,}$/;

/**
 * The screen above omo's input box: agent output lives there, and the box is the `❯` line followed by a bare rule.
 * A footer below it (relative age, monitor count) redraws without new output and must not look like one.
 */
export function outputRegion(screen: string): string {
  const lines = screen.split("\n").map((line) => line.trimEnd());
  for (let i = lines.length - 1; i > 0; i--) {
    if (!INPUT.test(lines[i] ?? "") || !RULE.test(lines[i + 1] ?? "")) continue;
    return lines
      .slice(0, i - 1)
      .join("\n")
      .trimEnd();
  }
  return lines.join("\n").trimEnd();
}

/**
 * One signature of the lane's checkout: how many files it holds and the newest mtime among them. A file written,
 * added or removed changes it; nothing else does. Undefined without a worktree or when no file can be read.
 */
export function checkoutStamp(root: string | undefined): string | undefined {
  if (root === undefined) return undefined;
  const dirs = [root];
  let visited = 0;
  let files = 0;
  let newest = 0;
  while (dirs.length > 0 && visited < WALK_LIMIT) {
    const dir = dirs.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited >= WALK_LIMIT) break;
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(path);
        continue;
      }
      try {
        const stat = statSync(path);
        files += 1;
        newest = Math.max(newest, stat.mtimeMs);
      } catch {
        // A file gone mid-walk is not evidence either way.
      }
    }
  }
  return files === 0 ? undefined : `${files}:${Math.round(newest)}`;
}

/** An unreadable screen contributes no signal: doubt never counts as silence. */
export async function observe(d: Deps, lane: Lane): Promise<Seen> {
  let screen: string | undefined;
  try {
    screen = digest(outputRegion(await d.runtimes.for(lane.sessionRef).read(lane.sessionRef, SCREEN_LINES)));
  } catch {
    screen = undefined;
  }
  const files = checkoutStamp(lane.worktree);
  return { ...(screen !== undefined ? { screen } : {}), ...(files !== undefined ? { files } : {}) };
}

/**
 * The next watch record, or undefined when this pass saw nothing at all. `moved`: output or files changed since the
 * last pass; the first observation only arms the watch.
 */
export function nextWatch(
  lane: Lane,
  seen: Seen,
  now: number,
): { readonly watch: LaneWatch; readonly moved: boolean } | undefined {
  if (seen.screen === undefined && seen.files === undefined) return undefined;
  const prev = lane.watch;
  const moved =
    prev !== undefined &&
    ((seen.screen !== undefined && prev.screen !== undefined && seen.screen !== prev.screen) ||
      (seen.files !== undefined && prev.files !== undefined && seen.files !== prev.files) ||
      (prev.screen === undefined && seen.screen !== undefined) ||
      (prev.files === undefined && seen.files !== undefined));
  return moved ? { watch: { at: now, ...seen }, moved } : { watch: prev ?? { at: now, ...seen }, moved };
}
