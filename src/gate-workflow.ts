import type { Deps } from "./harness.ts";
import type { MergeOutcome } from "./telemetry.ts";

type WorkflowRun = {
  id: number;
  workflow_id: number;
  name?: string | undefined;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
};

// The same green the check list uses: a neutral run is a skip in gh's buckets, anything else is not green.
const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

/** One page of workflow runs for the exact head, refusing every entry whose shape would let a run slip past unread. */
function parseWorkflowRuns(json: string): WorkflowRun[] {
  const page = JSON.parse(json) as { total_count?: unknown; workflow_runs?: unknown };
  if (typeof page.total_count !== "number" || !Array.isArray(page.workflow_runs)) {
    throw new Error("response has no workflow_runs list");
  }
  if (page.total_count > page.workflow_runs.length) {
    throw new Error(`only ${page.workflow_runs.length} of ${page.total_count} runs returned`);
  }
  return page.workflow_runs.map((raw: unknown, i: number) => {
    const run = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const { id, workflow_id, name, head_sha, event, status, conclusion } = run;
    const bad = [
      typeof id === "number" ? "" : "id",
      typeof workflow_id === "number" ? "" : "workflow_id",
      typeof head_sha === "string" ? "" : "head_sha",
      typeof event === "string" ? "" : "event",
      typeof status === "string" ? "" : "status",
      conclusion === null || typeof conclusion === "string" ? "" : "conclusion",
      name === undefined || name === null || typeof name === "string" ? "" : "name",
    ].filter(Boolean);
    if (bad.length > 0) throw new Error(`workflow run ${i} has an invalid ${bad.join(", ")}`);
    return {
      id: id as number,
      workflow_id: workflow_id as number,
      name: typeof name === "string" ? name : undefined,
      head_sha: head_sha as string,
      event: event as string,
      status: status as string,
      conclusion: conclusion as string | null,
    };
  });
}

/**
 * `gh pr checks` lists check runs only, so a `pull_request` workflow that waits for a maintainer's approval, fails to
 * start, or is cancelled is absent there while a check list of pass/skipping looks green. Ask the runs API for the
 * pull_request runs at the exact head and refuse every one not completed as success, skipped or neutral. An unreadable
 * or malformed answer refuses too: unknown workflow status is not green.
 */
export async function workflowRefusal(d: Deps, repo: string, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const at = sha.slice(0, 12);
  const res = await d.exec("gh", ["api", `repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request&per_page=100`]);
  if (res.code !== 0) {
    const why = res.stderr.trim() || `gh exited ${res.code}`;
    return [
      "workflow_status_unknown",
      `workflow runs at ${at} could not be read: ${why}; Actions status unavailable (permission denied or Actions disabled), so the merge stays refused until the status can be verified: use a credential with Actions read access or resolve repository settings`,
    ];
  }
  let runs: WorkflowRun[];
  try {
    runs = parseWorkflowRuns(res.stdout);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return ["workflow_status_unknown", `workflow runs at ${at} could not be read: ${why}`];
  }
  // A reopened PR or a newer run supersedes an older one, so only the latest run of each workflow counts, the way
  // GitHub itself merges: an older cancelled or stale run must not refuse a workflow whose newest run is green.
  const latest = new Map<number, WorkflowRun>();
  for (const r of runs) {
    if (r.head_sha !== sha || r.event !== "pull_request") continue;
    const seen = latest.get(r.workflow_id);
    if (!seen || r.id > seen.id) latest.set(r.workflow_id, r);
  }
  const blocked = [...latest.values()].filter(
    (r) => r.status !== "completed" || !GREEN_CONCLUSIONS.has(r.conclusion ?? ""),
  );
  if (blocked.length === 0) return undefined;
  const list = blocked.map((r) => `${r.name ?? "workflow"}=${r.conclusion ?? r.status}`).join(", ");
  return ["workflow_pending", `pull_request workflow run(s) not green at head ${at}: ${list}`];
}
