/** The two sweep backends; GitLab merge requests are swept through the `pr` vocabulary. */
export type ScmKind = "gh" | "glab";
export type ItemKind = "issue" | "pr";
export type Label = { readonly name: string };
export type LabelSpec = Label & { readonly color: string; readonly description: string };
export type SweepItem = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly Label[];
};
export type Comment = { readonly body: string; readonly createdAt: string };
export type StalePr = {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly comments: readonly Comment[];
  readonly reviews: readonly { readonly submittedAt: string }[];
};
export type StaleIssue = {
  readonly number: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly labels: readonly Label[];
  readonly comments: readonly Comment[];
};

/** GitHub label names are case-insensitive and ignore spaces around the colon; GitLab follows the same comparison. */
export const normaliseLabel = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s*:\s*/g, ":");

/** What `dori labels` and `dori stale` need from a code host; every method is read-only unless named as a write. */
export type Scm = {
  readonly kind: ScmKind;
  /** The identity used in output, the allowlist and the audit log: owner/repo (gh) or host/group/project (glab). */
  readonly repo: string;
  listIssues(state: "all" | "open"): Promise<SweepItem[]>;
  listPrs(state: "all" | "open"): Promise<SweepItem[]>;
  listStalePrs(): Promise<StalePr[]>;
  listStaleIssues(): Promise<StaleIssue[]>;
  ensureLabels(labels: readonly LabelSpec[]): Promise<void>;
  editLabels(kind: ItemKind, number: number, add: string | undefined, remove: readonly string[]): Promise<void>;
  commentPr(number: number, body: string): Promise<void>;
  closePr(number: number, body: string): Promise<void>;
  addIssueLabel(number: number, label: string): Promise<void>;
};
