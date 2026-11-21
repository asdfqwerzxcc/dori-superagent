// The gate's decision surface is the bundle MR's own review page, not a dori screen: `sop gate show` posts the
// rationale as a comment there, and `sop sync` reads the review back into the same receipt `sop gate approve|reject`
// writes. GitHub runs through gh, GitLab through glab; nothing here owns state beyond the SOP run.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { decideGate, gateView, type SopGateView } from "./sop-runs.ts";
import type { SopStore } from "./sop-store.ts";
import type { ExecResult } from "./runtime/exec.ts";

export type MrProvider = "gh" | "glab";

export const providerOf = (value: string | undefined): MrProvider => {
  if (value === undefined || value === "gh") return "gh";
  if (value === "glab") return "glab";
  throw new Refusal(`--provider must be gh or glab (got ${JSON.stringify(value)})`);
};

type Mr = { readonly repo: string; readonly number: number; readonly url: string };
type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

const why = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `exit ${r.code}`;

/** Markdown table cells stay one line: a newline breaks the row and a pipe ends the cell. */
const cell = (text: string, max = 200): string => {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

const iso = (at: number): string => new Date(at).toISOString();

export function rationaleOf(store: SopStore, runId: string, nodeId: string): { view: SopGateView; body: string } {
  const view = gateView(store, runId, nodeId);
  const def = store.required(view.sop);
  const run = store.run(runId);
  const record = view.bundleRecord;
  const lines = [
    `<!-- dori:sop-gate run=${runId} node=${nodeId} -->`,
    `### SOP gate \`${runId}\` / \`${nodeId}\` - ${view.state}`,
    "",
    "| field | value |",
    "| --- | --- |",
    `| SOP | \`${def.id}\` - ${cell(def.title)} |`,
    `| Bundle | \`${view.bundle}\`${record === undefined ? " (record missing)" : ` - ${cell(record.title)}`} |`,
    `| Gate | ${view.state} since ${iso(run.gate?.since ?? run.createdAt)} |`,
    "",
    "**Node chain**",
    "",
    "| node | kind | state | evidence |",
    "| --- | --- | --- | --- |",
  ];
  for (const node of def.nodes) {
    const at = run.nodes[node.id];
    lines.push(
      `| \`${node.id}\` | ${node.kind} | ${at?.state ?? "waiting"} | ${at?.note === undefined ? "-" : cell(at.note)} |`,
    );
  }
  if (record !== undefined && record.members.length > 0) {
    lines.push("", "**Bundle members**", "", "| lane | sha | verdict | reviewer |", "| --- | --- | --- | --- |");
    for (const m of record.members)
      lines.push(`| \`${m.lane}\` | \`${m.sha.slice(0, 12)}\` | ${m.verdict} | ${cell(m.reviewer)} |`);
  }
  lines.push(
    "",
    `**Decide here.** Approve this review to complete \`${nodeId}\`, or request changes with a reason to reject it. ` +
      `Then run \`dori sop sync ${runId}\`: it records the review with the same receipt as \`dori sop gate approve|reject\`.`,
  );
  return { view, body: lines.join("\n") };
}

export async function postGate(
  d: Deps,
  store: SopStore,
  runId: string,
  nodeId: string,
  provider: MrProvider,
): Promise<string[]> {
  const { view, body } = rationaleOf(store, runId, nodeId);
  const record = view.bundleRecord;
  if (record === undefined) return [`post: skipped (bundle ${view.bundle} is missing)`];
  const pr = record.pr;
  if (pr === null) return [`post: skipped (bundle ${view.bundle} has no MR; run: dori bundle land ${view.bundle})`];
  const r =
    provider === "gh"
      ? await d.exec("gh", ["pr", "comment", String(pr.number), "--repo", record.repo, "--body", body])
      : await d.exec("glab", ["mr", "note", String(pr.number), "--repo", record.repo, "--message", body]);
  if (r.code !== 0)
    throw new Refusal(`gate show: ${provider} comment on ${record.repo}#${pr.number} failed: ${why(r)}`);
  const url = r.stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .at(-1);
  return [`post: ${url ?? `${provider} ${record.repo}#${pr.number}`}`];
}

/** The latest decisive review per author: a later request for changes beats an earlier approval and vice versa. */
type ReviewState =
  | { readonly state: "approved"; readonly by?: string; readonly note?: string }
  | { readonly state: "changes-requested"; readonly by?: string; readonly reason?: string }
  | { readonly state: "none" };

const stateOfReview = (reviews: readonly Json[]): ReviewState => {
  const latest = new Map<string, { at: number; state: string; body: string }>();
  reviews.forEach((review, at) => {
    const author = asRecord(review["author"])?.["login"];
    const state = review["state"];
    if (typeof author !== "string" || author === "") return;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") return;
    latest.set(author, { at, state, body: typeof review["body"] === "string" ? review["body"].trim() : "" });
  });
  const ordered = [...latest.entries()].sort((a, b) => a[1].at - b[1].at);
  const changes = ordered.filter(([, review]) => review.state === "CHANGES_REQUESTED").at(-1);
  if (changes !== undefined) {
    const [by, review] = changes;
    return { state: "changes-requested", by, ...(review.body === "" ? {} : { reason: review.body }) };
  }
  const approved = ordered.filter(([, review]) => review.state === "APPROVED").at(-1);
  if (approved !== undefined) {
    const [by, review] = approved;
    return { state: "approved", by, ...(review.body === "" ? {} : { note: review.body }) };
  }
  return { state: "none" };
};

async function ghReviews(d: Deps, mr: Mr): Promise<ReviewState> {
  const r = await d.exec("gh", ["pr", "view", String(mr.number), "--repo", mr.repo, "--json", "reviews"]);
  if (r.code !== 0) throw new Refusal(`gh pr view ${mr.repo}#${mr.number} failed: ${why(r)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`gh pr view ${mr.repo}#${mr.number} printed no JSON`);
  }
  const reviews = asRecord(raw)?.["reviews"];
  if (!Array.isArray(reviews)) throw new Refusal(`gh pr view ${mr.repo}#${mr.number} printed no reviews`);
  return stateOfReview(reviews.map(asRecord).filter((review): review is Json => review !== undefined));
}

async function glabJson(d: Deps, path: string): Promise<unknown> {
  const r = await d.exec("glab", ["api", path]);
  if (r.code !== 0) throw new Refusal(`glab api ${path} failed: ${why(r)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`glab api ${path} printed no JSON`);
  }
}

async function glabReviews(d: Deps, mr: Mr): Promise<ReviewState> {
  const project = `projects/${encodeURIComponent(mr.repo)}/merge_requests/${mr.number}`;
  const [approvals, detail] = await Promise.all([glabJson(d, `${project}/approvals`), glabJson(d, project)]);
  const approvedBy = asRecord(approvals)?.["approved_by"];
  const approved = Array.isArray(approvedBy) ? approvedBy.map(asRecord).filter((r): r is Json => r !== undefined) : [];
  const record = asRecord(detail);
  const reviewers = Array.isArray(record?.["reviewers"]) ? record["reviewers"] : [];
  const requested = reviewers
    .map(asRecord)
    .filter((r): r is Json => r !== undefined)
    .filter((r) => r["state"] === "requested_changes");
  const changes = requested.length > 0 || record?.["detailed_merge_status"] === "requested_changes";
  if (changes) {
    const username = requested.at(-1)?.["username"];
    return { state: "changes-requested", ...(typeof username === "string" && username !== "" ? { by: username } : {}) };
  }
  if (approved.length > 0) {
    const username = asRecord(approved.at(-1)?.["user"])?.["username"];
    return { state: "approved", ...(typeof username === "string" && username !== "" ? { by: username } : {}) };
  }
  return { state: "none" };
}

const reviewerName = (by: string | undefined, fallback: string | undefined): string => {
  const name = (by ?? fallback ?? "").trim();
  if (name === "") throw new Refusal("the review does not name its author; pass --by <name> to record who decided");
  return name;
};

const firstLine = (text: string): string => text.split(/\r?\n/).find((line) => line.trim() !== "") ?? text;

export type SyncOutcome = { readonly lines: readonly string[]; readonly code: number };

/**
 * Reads the bundle MR's review state and reconciles it with the local gate. A pending gate takes the MR decision as its
 * own (same receipt as the typed command); a decided gate is compared and reported, never silently rewritten. A
 * mismatch is exit 1: the local receipt and the review page disagree, and only a person can say which one is right.
 */
export async function syncGate(
  d: Deps,
  store: SopStore,
  runId: string,
  provider: MrProvider,
  fallbackBy: string | undefined,
): Promise<SyncOutcome> {
  const run = store.run(runId);
  const gate = run.gate;
  if (gate === undefined) throw new Refusal(`run ${runId} has no approval gate to sync`);
  const view = gateView(store, runId, gate.node);
  const record = view.bundleRecord;
  if (record === undefined)
    throw new Refusal(`run ${runId}: bundle ${view.bundle} is missing (nothing to sync against)`);
  const pr = record.pr;
  if (pr === null)
    throw new Refusal(`run ${runId}: bundle ${view.bundle} has no MR (run: dori bundle land ${view.bundle})`);
  const mr: Mr = { repo: record.repo, number: pr.number, url: pr.url };

  const review = provider === "gh" ? await ghReviews(d, mr) : await glabReviews(d, mr);
  if (review.state === "none")
    return {
      lines: [
        gate.state === "pending"
          ? `SYNC ${runId} pending mr=no-decision`
          : `SYNC ${runId} gate=${gate.state} mr=no-decision (nothing to compare)`,
      ],
      code: 0,
    };

  if (gate.state === "pending") {
    const by = reviewerName(review.by, fallbackBy);
    if (review.state === "approved") {
      const { receipt } = decideGate(store, runId, "approve", by, undefined, review.note, d.now(), {
        source: "mr",
        mr: mr.url,
      });
      return { lines: [`SYNC ${runId} approve by=${by} receipt=${receipt} mr=${mr.url}`], code: 0 };
    }
    const reason = (review.reason ?? `changes requested on ${record.repo}#${pr.number}`).trim();
    const { receipt } = decideGate(store, runId, "reject", by, reason, undefined, d.now(), {
      source: "mr",
      mr: mr.url,
    });
    return {
      lines: [`SYNC ${runId} reject by=${by} receipt=${receipt} mr=${mr.url}`, `reason: ${firstLine(reason)}`],
      code: 0,
    };
  }

  const mrState = review.state === "approved" ? "approved" : "changes-requested";
  if (gate.state === "skipped")
    return { lines: [`SYNC ${runId} gate=skipped mr=${mrState} (a skip has no MR counterpart)`], code: 0 };
  const agrees =
    (gate.state === "approved" && review.state === "approved") ||
    (gate.state === "rejected" && review.state === "changes-requested");
  return agrees
    ? { lines: [`SYNC ${runId} gate=${gate.state} mr=${mrState} (in sync)`], code: 0 }
    : { lines: [`MISMATCH ${runId} gate=${gate.state} mr=${mrState}`], code: 1 };
}
