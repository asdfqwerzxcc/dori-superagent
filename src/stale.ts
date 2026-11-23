import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { one, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { assertWritable, loadRepoPolicy, type RepoPolicy } from "./repo-policy.ts";
import { resolveScm } from "./scm-target.ts";
import type { Comment, LabelSpec, Scm, StaleIssue, StalePr } from "./scm.ts";

export type { StaleIssue, StalePr } from "./scm.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NUDGE_SLACK_MS = 2000;
export const ISSUE_DAYS = 14;
export const NUDGE_MARKER = "<!-- dori-stale-nudge -->";
export const CLOSE_MARKER = "<!-- dori-stale-close -->";
export const NEEDS_INFO_LABEL = "needs-info";

const NEEDS_INFO: LabelSpec = {
  name: NEEDS_INFO_LABEL,
  color: "d4c5f9",
  description: "waiting on the reporter for information",
};

export type StaleAction = {
  readonly kind: "pr" | "issue";
  readonly number: number;
  readonly title: string;
  readonly action: "nudge" | "close" | "needs-info";
  readonly ageDays: number;
};
export type StaleOptions = { readonly now: number; readonly daysPr: number; readonly daysComment: number };

const timeOf = (iso: string): number | undefined => {
  const n = Date.parse(iso);
  return Number.isNaN(n) ? undefined : n;
};

/**
 * The last real movement: creation, an update (a push, review, or edit), or a comment that is not one of our own
 * nudges. Our nudge updates the PR too, so an updatedAt at or before the newest marker is not movement; that is what
 * stops the 7-day comment from resetting the 14-day close clock.
 */
export function lastMovementAt(item: StalePr | StaleIssue): number | undefined {
  const times: number[] = [];
  const add = (iso: string) => {
    const n = timeOf(iso);
    if (n !== undefined) times.push(n);
  };
  add(item.createdAt);
  const nudgeTimes = item.comments
    .filter((c) => c.body.includes(NUDGE_MARKER))
    .map((c) => timeOf(c.createdAt))
    .filter((n): n is number => n !== undefined);
  const lastNudge = nudgeTimes.length === 0 ? undefined : Math.max(...nudgeTimes);
  const updated = timeOf(item.updatedAt);
  if (updated !== undefined && (lastNudge === undefined || updated > lastNudge + NUDGE_SLACK_MS)) add(item.updatedAt);
  for (const c of item.comments) if (!c.body.includes(NUDGE_MARKER)) add(c.createdAt);
  if ("reviews" in item) for (const r of item.reviews) add(r.submittedAt);
  return times.length === 0 ? undefined : Math.max(...times);
}

export const ageInDays = (since: number, now: number): number => Math.max(0, Math.floor((now - since) / DAY_MS));

const nudgedSince = (comments: readonly Comment[], at: number): boolean =>
  comments.some((c) => c.body.includes(NUDGE_MARKER) && (timeOf(c.createdAt) ?? -1) >= at);

const hasNeedsInfo = (labels: readonly { readonly name: string }[]): boolean =>
  labels.some((l) => l.name.trim().toLowerCase() === NEEDS_INFO_LABEL);

export function planPr(pr: StalePr, o: StaleOptions): StaleAction | undefined {
  const since = lastMovementAt(pr);
  if (since === undefined) return undefined;
  const ageDays = ageInDays(since, o.now);
  if (ageDays >= o.daysPr) return { kind: "pr", number: pr.number, title: pr.title, action: "close", ageDays };
  if (ageDays >= o.daysComment && !nudgedSince(pr.comments, since))
    return { kind: "pr", number: pr.number, title: pr.title, action: "nudge", ageDays };
  return undefined;
}

/** An issue is never closed here: after the stale window it only earns the needs-info label, once. */
export function planIssue(issue: StaleIssue, o: StaleOptions): StaleAction | undefined {
  if (hasNeedsInfo(issue.labels)) return undefined;
  const since = lastMovementAt(issue);
  if (since === undefined) return undefined;
  const ageDays = ageInDays(since, o.now);
  return ageDays >= ISSUE_DAYS
    ? { kind: "issue", number: issue.number, title: issue.title, action: "needs-info", ageDays }
    : undefined;
}

export function planStale(prs: readonly StalePr[], issues: readonly StaleIssue[], o: StaleOptions): StaleAction[] {
  return [...prs.map((p) => planPr(p, o)), ...issues.map((i) => planIssue(i, o))]
    .filter((x): x is StaleAction => x !== undefined)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number);
}

export const formatStaleAction = (x: StaleAction): string =>
  `STALE ${x.action} ${x.kind}#${x.number} age=${x.ageDays}d (${x.title})`;

export const nudgeText = (ageDays: number, noun = "PR"): string =>
  `${NUDGE_MARKER}\nNo activity here for ${ageDays} days. If this ${noun} is still planned, reply with a one-line reason ` +
  `for the pause; otherwise close it. A ${noun} that reaches the stale close limit is closed automatically.`;

export const closeText = (ageDays: number): string =>
  `${CLOSE_MARKER}\nClosing after ${ageDays} days without movement. Comment or reopen if work resumes; the rule is ` +
  "documented in docs/ops-protocol.md.";

const days = (raw: string | undefined, fallback: number, flag: string): number => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Refusal(`${flag} must be a positive number of days`);
  return n;
};

type Audit = {
  readonly at: string;
  readonly repo: string;
  readonly kind: string;
  readonly number: number;
  readonly action: string;
  readonly ageDays: number;
  readonly ok: boolean;
  readonly error?: string;
};

function audit(d: Deps, rec: Audit): void {
  const dir = join(d.store.root, "state");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "stale-audit.jsonl"), `${JSON.stringify(rec)}\n`);
}

async function applyStale(d: Deps, scm: Scm, x: StaleAction): Promise<void> {
  const base = {
    at: new Date(d.now()).toISOString(),
    repo: scm.repo,
    kind: x.kind,
    number: x.number,
    action: x.action,
    ageDays: x.ageDays,
  };
  try {
    if (x.action === "nudge") await scm.commentPr(x.number, nudgeText(x.ageDays, scm.kind === "glab" ? "MR" : "PR"));
    else if (x.action === "close") await scm.closePr(x.number, closeText(x.ageDays));
    else await scm.addIssueLabel(x.number, NEEDS_INFO_LABEL);
    audit(d, { ...base, ok: true });
  } catch (e) {
    audit(d, { ...base, ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export async function runStale(d: Deps, a: Args, policy: RepoPolicy = loadRepoPolicy()): Promise<number> {
  const scm = await resolveScm(d, a);
  const apply = one(a, "apply") === "true";
  const daysPr = days(one(a, "days-pr"), 14, "--days-pr");
  const daysComment = days(one(a, "days-comment"), 7, "--days-comment");
  assertWritable(policy, scm.repo, apply);
  const [prs, issues] = await Promise.all([scm.listStalePrs(), scm.listStaleIssues()]);
  const actions = planStale(prs, issues, { now: d.now(), daysPr, daysComment });
  for (const x of actions) console.log(formatStaleAction(x));
  if (apply && actions.some((x) => x.action === "needs-info")) await scm.ensureLabels([NEEDS_INFO]);
  if (apply) for (const x of actions) await applyStale(d, scm, x);
  console.log(
    `STALE ${scm.repo} prs=${prs.length} issues=${issues.length} actions=${actions.length} ${apply ? "applied" : "dry-run"}`,
  );
  return 0;
}
