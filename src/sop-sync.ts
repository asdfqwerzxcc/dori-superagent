// The review half of the MR gate: read the bundle MR's latest decisive reviews and reconcile them with the local gate.
// A pending gate takes the MR decision as its own (the same receipt as the typed command); a decided gate is compared
// and reported, never silently rewritten. `sop-mr.ts` owns the comment this reads around.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { asRecord, glabJson, why, type Json, type Mr, type MrProvider } from "./sop-mr.ts";
import { decideGate, gateView } from "./sop-runs.ts";
import type { SopStore } from "./sop-store.ts";

/** The latest decisive review per author; any outstanding change request wins over approvals, as on GitHub. */
type ReviewState =
  | { readonly state: "approved"; readonly by?: string; readonly note?: string }
  | { readonly state: "changes-requested"; readonly by?: string; readonly reason?: string }
  | { readonly state: "none" };

const atOf = (review: Json, index: number): number => {
  const submitted = review["submittedAt"];
  return typeof submitted === "string" && !Number.isNaN(Date.parse(submitted)) ? Date.parse(submitted) : index;
};

const stateOfReview = (reviews: readonly Json[]): ReviewState => {
  const latest = new Map<string, { at: number; state: string; body: string }>();
  reviews.forEach((review, index) => {
    const author = asRecord(review["author"])?.["login"];
    const state = review["state"];
    if (typeof author !== "string" || author === "") return;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") return;
    const at = atOf(review, index);
    const old = latest.get(author);
    if (old !== undefined && old.at > at) return;
    latest.set(author, {
      at,
      state,
      body: typeof review["body"] === "string" ? review["body"].trim() : "",
    });
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

async function glabReviews(d: Deps, mr: Mr): Promise<ReviewState> {
  const project = `projects/${encodeURIComponent(mr.repo)}/merge_requests/${mr.number}`;
  const [approvals, detail] = await Promise.all([glabJson(d, `${project}/approvals`), glabJson(d, project)]);
  const approvedBy = asRecord(approvals)?.["approved_by"];
  const approved = Array.isArray(approvedBy) ? approvedBy.map(asRecord).filter((r): r is Json => r !== undefined) : [];
  const record = asRecord(detail);
  // GitLab signals requested changes either per reviewer (newer MR detail responses) or as the MR's
  // detailed_merge_status; accept either so a version difference does not silently drop a change request.
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
    // The approvals endpoint does not document an order; the last entry is the most recent in practice.
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
