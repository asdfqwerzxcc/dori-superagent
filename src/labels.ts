import { one, type Args } from "./cli-args.ts";
import { ghList, ghText, SWEEP_LIMIT } from "./gh-sweep.ts";
import type { Deps } from "./harness.ts";
import { assertWritable, loadRepoPolicy, repoArg } from "./repo-policy.ts";

/** The five exclusive states an issue or PR can be in; every item carries exactly one of them. */
export const STATUS_LABELS = [
  "status:triage",
  "status:ready",
  "status:in-progress",
  "status:blocked",
  "status:done",
] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

/** On a conflict the state that must not be lost wins: blocked, then the owned state, then readiness, then triage. */
export const STATUS_PRECEDENCE: readonly StatusLabel[] = [
  "status:blocked",
  "status:in-progress",
  "status:ready",
  "status:triage",
  "status:done",
];

type Label = { readonly name: string };
export type LabelledItem = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly Label[];
};
export type LabelKind = "issue" | "pr";
export type LabelPlan = {
  readonly kind: LabelKind;
  readonly number: number;
  readonly title: string;
  readonly add?: string;
  readonly remove: readonly string[];
};

/** GitHub label names are case-insensitive and ignore spaces around the colon. */
export const normaliseLabel = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/g, ":");

const statusOf = (name: string): StatusLabel | undefined => STATUS_LABELS.find((s) => s === normaliseLabel(name));

export type FoundStatus = { readonly canonical: StatusLabel; readonly actual: string };

export const statusLabelsOf = (labels: readonly Label[]): FoundStatus[] =>
  labels.flatMap(({ name }) => {
    const canonical = statusOf(name);
    return canonical === undefined ? [] : [{ canonical, actual: name }];
  });

const pick = (present: ReadonlySet<StatusLabel>): StatusLabel =>
  STATUS_PRECEDENCE.find((s) => present.has(s)) ?? "status:triage";

/**
 * Only an item with zero or two-or-more status labels is touched. A closed item becomes done; an open item with no
 * label starts at triage, and a conflicting open item keeps the state precedence ranks highest.
 */
export function planLabel(kind: LabelKind, item: LabelledItem): LabelPlan | undefined {
  const found = statusLabelsOf(item.labels);
  if (found.length === 1) return undefined;
  const target = item.state.toUpperCase() === "OPEN" ? pick(new Set(found.map((f) => f.canonical))) : "status:done";
  const keep = found.find((f) => f.canonical === target);
  const remove = found.filter((f) => f.canonical !== target).map((f) => f.actual);
  return { kind, number: item.number, title: item.title, ...(keep === undefined ? { add: target } : {}), remove };
}

export const formatLabelPlan = (p: LabelPlan): string =>
  `LABEL ${p.kind}#${p.number}${p.add === undefined ? "" : ` add ${p.add}`}${p.remove.length > 0 ? ` remove ${p.remove.join(",")}` : ""} (${p.title})`;

const LABEL_META: Record<StatusLabel, { readonly color: string; readonly description: string }> = {
  "status:triage": { color: "ededed", description: "not triaged yet" },
  "status:ready": { color: "0e8a16", description: "scoped and ready to start" },
  "status:in-progress": { color: "fbca04", description: "a lane owns this now" },
  "status:blocked": { color: "d93f0b", description: "waiting on a human or another change" },
  "status:done": { color: "6f42c1", description: "landed or closed" },
};

const ITEM_FIELDS = "number,title,state,labels";

async function fetchItems(
  d: Deps,
  repo: string,
): Promise<{ readonly issues: LabelledItem[]; readonly prs: LabelledItem[] }> {
  const [issues, prs] = await Promise.all([
    ghList<LabelledItem>(d, [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      SWEEP_LIMIT,
      "--json",
      ITEM_FIELDS,
    ]),
    ghList<LabelledItem>(d, [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      SWEEP_LIMIT,
      "--json",
      ITEM_FIELDS,
    ]),
  ]);
  return { issues, prs };
}

async function ensureStatusLabels(d: Deps, repo: string): Promise<void> {
  for (const label of STATUS_LABELS) {
    const meta = LABEL_META[label];
    const r = await d.exec("gh", [
      "label",
      "create",
      label,
      "--repo",
      repo,
      "--color",
      meta.color,
      "--description",
      meta.description,
    ]);
    if (r.code !== 0 && !/already exists/i.test(`${r.stderr}${r.stdout}`))
      throw new Error(`gh label create ${label} failed: ${(r.stderr || r.stdout).trim()}`);
  }
}

async function applyLabelPlan(d: Deps, repo: string, plan: LabelPlan): Promise<void> {
  const argv = [plan.kind, "edit", String(plan.number), "--repo", repo];
  if (plan.add !== undefined) argv.push("--add-label", plan.add);
  for (const name of plan.remove) argv.push("--remove-label", name);
  await ghText(d, argv);
}

export async function runLabels(d: Deps, a: Args): Promise<number> {
  const repo = await repoArg(d, a);
  const apply = one(a, "apply") === "true";
  assertWritable(loadRepoPolicy(), repo, apply);
  const { issues, prs } = await fetchItems(d, repo);
  const plans = [...issues.map((i) => planLabel("issue", i)), ...prs.map((p) => planLabel("pr", p))].filter(
    (p): p is LabelPlan => p !== undefined,
  );
  for (const plan of plans) console.log(formatLabelPlan(plan));
  if (apply && plans.length > 0) {
    await ensureStatusLabels(d, repo);
    for (const plan of plans) await applyLabelPlan(d, repo, plan);
  }
  console.log(
    `LABELS ${repo} items=${issues.length + prs.length} changes=${plans.length} ${apply ? "applied" : "dry-run"}`,
  );
  return 0;
}
