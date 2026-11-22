import type { SessionRef } from "./runtime/types.ts";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost" | "dropped";

/**
 * One lane record. `sessionRef` is the session it runs in, on whichever runtime opened it; `paneId`/`tabId` are written
 * beside it (the ref's id and container) so an older binary still reads the file. `migratedFrom`: the sessions it ran in
 * before a `dori migrate`. `migration`: a handover is in progress, and the duty loop leaves the record alone.
 * `sessionPath`: the agent's own session file, when its command records one; `dori migrate --resume` needs it.
 * `repo`/`baseSha`/`tipSha`: the main checkout the lane lands in, the commit it started from and the commit the review
 * gate pins. `worktree`: the lane's own checkout, created at start under `<home>/worktrees/<key>`; the lane commits
 * there and `laneRepo` prefers it. A lane without a repository has neither. A lane from before the gate has no base,
 * and `dori review --lane` refuses it rather than guessing one.
 */
export type Lane = {
  key: string;
  sessionRef: SessionRef;
  migratedFrom?: SessionRef[];
  migration?: true;
  sessionPath?: string;
  paneId: string;
  tabId: string;
  brief: string;
  cwd: string;
  worktree?: string;
  repo?: string;
  baseSha?: string;
  tipSha?: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  final?: { text: string; evidence: string[]; at: number };
  /** The last pane output and checkout signature the duty loop saw, for demoting a stale `working` record. */
  watch?: LaneWatch;
  log: {
    at: number;
    kind: "start" | "report" | "ready" | "nudge" | "demoted" | "done" | "lost" | "dropped";
    text: string;
  }[];
};

/** `at`: when the current output/files snapshot was first seen; hashes, so the lane record stays small. */
export type LaneWatch = { at: number; screen?: string; files?: string };

/** The sessions `dori up` opens; roles.json maps each to a ref string (a bare herdr pane id, or `hc:t7`). */
export type Role = "lead" | "duty" | "duty-loop" | "hourly-loop";

/**
 * A delivery that failed after the message may have reached the pane (#89). `typed`: the text is in the pane's input
 * and only Enter is retried; `agent` and `pgid` record which agent it was typed into (#108, see AgentIdentity).
 * `ambiguous`: it may or may not have arrived; it is held, never resent automatically.
 */
export type DeliveryAttempt = {
  at: number;
  state: "typed" | "ambiguous";
  detail?: string;
  agent?: string;
  pgid?: number;
};

/** A flush lock from another host (or an unreadable one) older than this is taken over; on this host only a dead pid frees it (#108). */
export const INBOX_LOCK_STALE_MS = 60_000;

export type QueuedMessage = { at: number; from: string; text: string; attempt?: DeliveryAttempt };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
};

/** A reviewer's answer to one lane diff. `reviewer_timeout` and `reviewer_empty` are failed reviews: they are
 * receipts like any other, and a `done` gate refuses them rather than treating a missing answer as pending. */
export type LaneVerdict = "CLEAR" | "BLOCK" | "reviewer_timeout" | "reviewer_empty";

/** The verdict a reviewer gave one lane diff: `receipts/lane_<key>@<tip>.json`. */
export type LaneReceipt = {
  lane: string;
  verdict: LaneVerdict;
  base: string;
  tip: string;
  brief: string;
  reviewer: string;
  at: number;
  summary: string;
};

/**
 * A bundle of finished lanes that lands as one `bundle/<id>` branch and one MR.
 * `members` records the lane receipt each member was admitted on, so the bundle gate can be re-checked later.
 * `issue` is the representative issue: only it may be closed by the MR; other issues would be Refs.
 */
export type BundleMember = { lane: string; sha: string; verdict: "CLEAR"; reviewer: string };
export type Bundle = {
  id: string;
  title: string;
  issue: number | null;
  repo: string;
  members: BundleMember[];
  branch: string;
  pr: { number: number; url: string } | null;
  status: "open" | "landed" | "closed";
};

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

export type HostLoad = { load1: number; cores: number; memFreePct: number };

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;
/** Role names are send targets, and resolveTarget tries roles first, so a lane with one of these keys could never be reached. */
export const RESERVED_KEYS: readonly Role[] = ["lead", "duty", "duty-loop", "hourly-loop"];
/** Refusal text for a reserved lane key, or undefined. Keys are lowercase-only (KEY_RE), so the exact match is the whole check. */
export const reservedKey = (key: string): string | undefined =>
  (RESERVED_KEYS as readonly string[]).includes(key) ? `lane key "${key}" is reserved for the ${key} role` : undefined;
