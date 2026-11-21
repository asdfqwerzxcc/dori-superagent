// The gate's decision surface is the bundle MR's own review page, not a dori screen: `gate show` posts the rationale as
// one comment there (and updates that comment on later calls), while `sop-sync.ts` reads the review back into the same
// receipt `sop gate approve|reject` writes. This module owns only the comment.

import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { gateView, type SopGateView } from "./sop-runs.ts";
import type { SopStore } from "./sop-store.ts";
import type { ExecResult } from "./runtime/exec.ts";

export type MrProvider = "gh" | "glab";
export type Mr = { readonly repo: string; readonly number: number; readonly url: string };
export type Json = Record<string, unknown>;

export const asRecord = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

export const why = (r: ExecResult): string => (r.stderr || r.stdout).trim() || `exit ${r.code}`;

export const providerOf = (value: string | undefined): MrProvider => {
  if (value === undefined || value === "gh") return "gh";
  if (value === "glab") return "glab";
  throw new Refusal(`--provider must be gh or glab (got ${JSON.stringify(value)})`);
};

const glabProject = (repo: string, number: number): string =>
  `projects/${encodeURIComponent(repo)}/merge_requests/${number}`;

const ghRepo = (repo: string): string => repo.split("/").map(encodeURIComponent).join("/");

export async function glabJson(d: Deps, path: string): Promise<unknown> {
  const r = await d.exec("glab", ["api", path]);
  if (r.code !== 0) throw new Refusal(`glab api ${path} failed: ${why(r)}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`glab api ${path} printed no JSON`);
  }
}

/** Markdown table cells stay one line: a newline breaks the row and a pipe ends the cell. */
const cell = (text: string, max = 200): string => {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
};

const iso = (at: number): string => new Date(at).toISOString();

const marker = (runId: string, nodeId: string): string => `<!-- dori:sop-gate run=${runId} node=${nodeId} -->`;

export function rationaleOf(store: SopStore, runId: string, nodeId: string): { view: SopGateView; body: string } {
  const view = gateView(store, runId, nodeId);
  const def = store.required(view.sop);
  const run = store.run(runId);
  const record = view.bundleRecord;
  const lines = [
    marker(runId, nodeId),
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

type Posted = { readonly id: string; readonly url: string };

async function ghPosted(d: Deps, mr: Mr, want: string): Promise<Posted | undefined> {
  const r = await d.exec("gh", ["pr", "view", String(mr.number), "--repo", mr.repo, "--json", "comments"]);
  if (r.code !== 0) throw new Refusal(`gh pr view ${mr.repo}#${mr.number} comments failed: ${why(r)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new Refusal(`gh pr view ${mr.repo}#${mr.number} printed no JSON`);
  }
  const comments = asRecord(raw)?.["comments"];
  if (!Array.isArray(comments)) throw new Refusal(`gh pr view ${mr.repo}#${mr.number} printed no comments`);
  for (const item of comments) {
    const comment = asRecord(item);
    const body = comment?.["body"];
    const url = comment?.["url"];
    if (typeof body !== "string" || !body.includes(want) || typeof url !== "string") continue;
    const id = /#issuecomment-(\d+)$/.exec(url)?.[1];
    if (id !== undefined) return { id, url };
  }
  return undefined;
}

async function glabPosted(d: Deps, mr: Mr, want: string): Promise<Posted | undefined> {
  const raw = await glabJson(d, `${glabProject(mr.repo, mr.number)}/notes?per_page=100`);
  const notes = Array.isArray(raw) ? raw : [];
  for (const item of notes) {
    const note = asRecord(item);
    const body = note?.["body"];
    const id = note?.["id"];
    if (typeof body !== "string" || !body.includes(want)) continue;
    if (typeof id !== "number" && typeof id !== "string") continue;
    return { id: String(id), url: `${mr.url}#note_${id}` };
  }
  return undefined;
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
  const mr: Mr = { repo: record.repo, number: pr.number, url: pr.url };
  const posted =
    provider === "gh" ? await ghPosted(d, mr, marker(runId, nodeId)) : await glabPosted(d, mr, marker(runId, nodeId));
  if (posted !== undefined) {
    const r =
      provider === "gh"
        ? await d.exec("gh", [
            "api",
            "--method",
            "PATCH",
            `repos/${ghRepo(record.repo)}/issues/comments/${posted.id}`,
            "-f",
            `body=${body}`,
          ])
        : await d.exec("glab", [
            "api",
            "--method",
            "PUT",
            `${glabProject(record.repo, pr.number)}/notes/${posted.id}`,
            "-f",
            `body=${body}`,
          ]);
    if (r.code !== 0)
      throw new Refusal(`gate show: updating the MR comment on ${record.repo}#${pr.number} failed: ${why(r)}`);
    return [`post: updated ${posted.url}`];
  }
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
