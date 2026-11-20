// `dori bundle close` runs after the PR merged: it verifies the body closes only the representative issue, leaves one
// `Refs` comment for every member receipt, and marks the record closed. It never closes an issue itself.

import { checkedBundle, short } from "./bundles.ts";
import { withoutComments } from "./bundle-land.ts";
import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import type { ExecResult } from "./runtime/exec.ts";

const ghWhy = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `gh exited ${r.code}`;

type PrView = { readonly state: string; readonly body: string; readonly url: string };

async function viewPr(d: Deps, repo: string, number: number): Promise<PrView> {
  const r = await d.exec("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state,body,url"]);
  if (r.code !== 0) throw new Refusal(`gh pr view #${number} failed: ${ghWhy(r)}`);
  let raw: { state?: unknown; body?: unknown; url?: unknown };
  try {
    raw = JSON.parse(r.stdout) as typeof raw;
  } catch {
    throw new Refusal(`gh pr view #${number} printed no JSON`);
  }
  if (typeof raw.state !== "string" || typeof raw.body !== "string" || typeof raw.url !== "string")
    throw new Refusal(`gh pr view #${number} printed an incomplete PR`);
  return { state: raw.state, body: raw.body, url: raw.url };
}

export async function closeBundle(d: Deps, id: string, text?: string): Promise<string> {
  const bundle = checkedBundle(d, id);
  if (bundle.status === "closed") throw new Refusal(`bundle ${id} is already closed`);
  if (bundle.pr === null) throw new Refusal(`bundle ${id} has no PR; run: dori bundle land ${id}`);
  const view = await viewPr(d, bundle.repo, bundle.pr.number);
  if (view.state !== "MERGED")
    throw new Refusal(
      `bundle ${id}: PR #${bundle.pr.number} is ${view.state}, not MERGED; close runs after the bundle PR lands`,
    );
  const closes = [...withoutComments(view.body).matchAll(/\bCloses\s+#(\d+)\b/gi)].map((m) => Number(m[1]));
  const stray = closes.find((n) => n !== bundle.issue);
  if (stray !== undefined)
    throw new Refusal(
      bundle.issue === null
        ? `bundle ${id}: PR #${bundle.pr.number} closes #${stray}, but the bundle has no representative issue; only a representative issue may be closed`
        : `bundle ${id}: PR #${bundle.pr.number} closes #${stray}, not the representative issue #${bundle.issue}; other issues are Refs`,
    );
  const refs = bundle.members.map((m) => `- Refs lane/${m.lane}@${short(m.sha)} (${m.verdict}, ${m.reviewer})`);
  const head = `bundle ${id}: this PR lands ${bundle.members.length} local PR${bundle.members.length === 1 ? "" : "s"}.`;
  const extra = text?.trim();
  const body = [head, ...refs, ...(extra === undefined || extra === "" ? [] : ["", extra])].join("\n");
  const comment = await d.exec("gh", [
    "pr",
    "comment",
    String(bundle.pr.number),
    "--repo",
    bundle.repo,
    "--body",
    body,
  ]);
  if (comment.code !== 0) throw new Refusal(`bundle ${id}: gh pr comment failed: ${ghWhy(comment)}`);
  bundle.status = "closed";
  d.store.saveBundle(bundle);
  return `CLOSED ${id} pr=#${bundle.pr.number} comment=${bundle.members.length} refs`;
}
