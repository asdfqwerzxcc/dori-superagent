import { laneForItem, log, reconcileRunningItems, type ReconcileEvent } from "./backlog.ts";
import type { Deps } from "./harness.ts";
import type { LoopRun } from "./store-types.ts";

const PR_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

async function ghState(d: Deps, kind: "pr" | "issue", repo: string, n: string): Promise<string> {
  const r = await d.exec("gh", [kind, "view", n, "--repo", repo, "--json", "state"]);
  if (r.code !== 0)
    throw new Error(`gh ${kind} view ${repo}#${n}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return String((JSON.parse(r.stdout) as { state?: string }).state);
}

/** Reconcile open and running items with the lanes, PRs and issues the loop can read. */
export async function sync(d: Deps, run: LoopRun): Promise<ReconcileEvent[]> {
  const reconciled = reconcileRunningItems(d, { countAttempts: true });
  for (const event of reconciled) run.synced.push(event.text);
  for (const item of d.store.items()) {
    try {
      if (item.status === "running") {
        const lane = laneForItem(d, item.id);
        if (lane?.status === "ready") {
          const m = lane.final?.evidence.map((e) => PR_RE.exec(e)).find(Boolean);
          if (m && (await ghState(d, "pr", m[1]!, m[2]!)) === "MERGED") {
            item.status = "done";
            log(d, item, "done", "PR merged");
            run.synced.push(`${item.id} done (PR merged)`);
            run.findings.push(`${item.id} READY and its PR merged: dori done ${item.id}`);
          }
        }
      } else if (item.status === "open" && item.source) {
        const [repo, n] = item.source.split("#");
        if ((await ghState(d, "issue", repo!, n!)) === "CLOSED") {
          item.status = "dropped";
          log(d, item, "drop", "source issue closed");
          run.synced.push(`${item.id} dropped (${item.source} closed)`);
        }
      }
    } catch (e) {
      run.findings.push(`gh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return reconciled;
}
