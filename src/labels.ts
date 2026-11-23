import { one, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { assertWritable, loadRepoPolicy, type RepoPolicy } from "./repo-policy.ts";
import { normaliseLabel, type Label, type LabelSpec, type Scm, type SweepItem } from "./scm.ts";
import { resolveScm } from "./scm-target.ts";

/** The five exclusive states an issue or pull request can be in; every item carries exactly one of them. */
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

export type LabelledItem = SweepItem;
export type LabelKind = "issue" | "pr";
export type LabelPlan = {
  readonly kind: LabelKind;
  readonly number: number;
  readonly title: string;
  readonly add?: string;
  readonly remove: readonly string[];
};

export { normaliseLabel };

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

const STATUS_SPECS: readonly LabelSpec[] = STATUS_LABELS.map((name) => ({ name, ...LABEL_META[name] }));

async function fetchItems(scm: Scm): Promise<{ readonly issues: SweepItem[]; readonly prs: SweepItem[] }> {
  const [issues, prs] = await Promise.all([scm.listIssues("all"), scm.listPrs("all")]);
  return { issues, prs };
}

export async function runLabels(d: Deps, a: Args, policy: RepoPolicy = loadRepoPolicy()): Promise<number> {
  const scm = await resolveScm(d, a);
  const apply = one(a, "apply") === "true";
  assertWritable(policy, scm.repo, apply);
  const { issues, prs } = await fetchItems(scm);
  const plans = [...issues.map((i) => planLabel("issue", i)), ...prs.map((p) => planLabel("pr", p))].filter(
    (p): p is LabelPlan => p !== undefined,
  );
  for (const plan of plans) console.log(formatLabelPlan(plan));
  if (apply && plans.length > 0) {
    await scm.ensureLabels(STATUS_SPECS);
    for (const plan of plans) await scm.editLabels(plan.kind, plan.number, plan.add, plan.remove);
  }
  console.log(
    `LABELS ${scm.repo} items=${issues.length + prs.length} changes=${plans.length} ${apply ? "applied" : "dry-run"}`,
  );
  return 0;
}
