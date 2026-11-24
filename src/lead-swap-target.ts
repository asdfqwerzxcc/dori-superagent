// Where the lead is, and how to relaunch it: the pane's process tree, the session file that tree is writing, the
// prompt it was started with, and the engine runtime it materializes. Split from lead-swap.ts for the 250-line rule.

import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { shq } from "./delivery.ts";
import type { Proc } from "./lead-process-list.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const norm = (text: string): string => text.replaceAll("\\", "/").toLowerCase();
const isOmo = (command: string): boolean => norm(command).includes("omo.js");

/** `--flag value` / `--flag=value`, with the value quoted or bare; the first non-empty capture wins. */
const argOf = (command: string, flag: string): string | undefined => {
  const m = new RegExp(`${flag}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`).exec(command);
  return m?.[1] ?? m?.[2] ?? m?.[3];
};

export const sessionOf = (command: string): string | undefined => argOf(command, "--session");
export const promptOf = (command: string): string | undefined => argOf(command, "--append-system-prompt");

export type LeadStack = {
  /** Every process in the pane's tree that is part of the lead: `omo.js`, or the lead prompt path. */
  readonly matched: readonly Proc[];
  /** The topmost matched process of each stack: killing its tree kills the lead, not the pane shell. */
  readonly roots: readonly Proc[];
  readonly session?: string;
  readonly prompt?: string;
};

function descendantsOf(procs: readonly Proc[], rootPid: number): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    if (p.parent === undefined) continue;
    const list = children.get(p.parent);
    if (list === undefined) children.set(p.parent, [p]);
    else list.push(p);
  }
  const out: Proc[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * The lead process stack inside one pane. `paneRootPid` is the pane shell (herdr `process_info.shell_pid`); with no
 * root pid the whole process table is the scope, so the caller must treat more than one root as ambiguous. A process
 * matches when its command line carries `omo.js` or the lead's `--append-system-prompt` path; the duty stack carries
 * `duty.md`, so it is never selected.
 */
export function matchLeadStack(
  procs: readonly Proc[],
  paneRootPid: number | undefined,
  promptPath?: string,
): LeadStack {
  const scope = paneRootPid === undefined ? procs : descendantsOf(procs, paneRootPid);
  const matched = scope.filter(
    (p) =>
      isOmo(p.command) || (promptPath !== undefined && promptPath !== "" && norm(p.command).includes(norm(promptPath))),
  );
  const matchedPids = new Set(matched.map((p) => p.pid));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const roots = matched.filter((p) => {
    const seen = new Set<number>();
    let parent = p.parent;
    while (parent !== undefined && !seen.has(parent)) {
      if (matchedPids.has(parent)) return false;
      seen.add(parent);
      parent = byPid.get(parent)?.parent;
    }
    return true;
  });
  const session = matched.map((p) => sessionOf(p.command)).find((s) => s !== undefined);
  const prompt = matched.map((p) => promptOf(p.command)).find((s) => s !== undefined) ?? promptPath;
  return {
    matched,
    roots,
    ...(session === undefined ? {} : { session }),
    ...(prompt === undefined || prompt === "" ? {} : { prompt }),
  };
}

/** The project session directory omo derives from a cwd: `C:\Users\USER` -> `--C--Users-USER--`. */
export const projectDirName = (cwd: string): string => `--${cwd.replace(/[\\/]+$/, "").replace(/[\\/:]/g, "-")}--`;

function headerCwd(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
    const record = JSON.parse(first) as { cwd?: unknown };
    return typeof record.cwd === "string" ? record.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The session file the lead is currently writing: the newest `.jsonl` under the cwd's project directory, preferring
 * one written in the last day. A file whose header names a different cwd is skipped; a file with no readable header is
 * accepted, because a session that is being written must not be discarded over one malformed line.
 */
export function newestSession(sessionsRoot: string, cwd: string, now = Date.now()): string | undefined {
  if (cwd === "") return undefined;
  const dir = join(sessionsRoot, projectDirName(cwd));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  const files = names
    .flatMap((name) => {
      const path = join(dir, name);
      try {
        return [{ path, mtime: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  const recent = files.filter((f) => now - f.mtime <= DAY_MS);
  const ordered = [...recent, ...files.filter((f) => now - f.mtime > DAY_MS)];
  for (const file of ordered) {
    const recorded = headerCwd(file.path);
    if (recorded === undefined || norm(recorded) === norm(cwd)) return file.path;
  }
  return undefined;
}

/** The build id of the newest materialized engine runtime (`<home>/.omo/agent/runtime/<build>/runtime-snapshot.json`). */
export function readRuntimeBuild(runtimeRoot: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(runtimeRoot);
  } catch {
    return undefined;
  }
  const snapshots = entries
    .flatMap((name) => {
      const path = join(runtimeRoot, name, "runtime-snapshot.json");
      try {
        return [{ path, mtime: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const snapshot of snapshots) {
    try {
      const record = JSON.parse(readFileSync(snapshot.path, "utf8")) as { buildId?: unknown };
      if (typeof record.buildId === "string" && record.buildId !== "") return record.buildId;
    } catch {
      // Try the next build.
    }
  }
  return undefined;
}

/** One shell word: PowerShell single quotes on Windows, POSIX single quotes elsewhere. */
export const quoteArg = (text: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? `'${text.replaceAll("'", "''")}'` : shq(text);

export const buildLeadCommand = (
  agentCmd: string,
  session: string,
  prompt: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string =>
  `${agentCmd} --session ${quoteArg(session, platform)}${
    prompt === undefined ? "" : ` --append-system-prompt ${quoteArg(prompt, platform)}`
  }`;
