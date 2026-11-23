import { ghList, ghText, SWEEP_LIMIT } from "./gh-sweep.ts";
import type { Deps } from "./harness.ts";
import type { ItemKind, LabelSpec, Scm, StaleIssue, StalePr, SweepItem } from "./scm.ts";

const ITEM_FIELDS = "number,title,state,labels";

/** The GitHub backend; every argv is the pre-adapter one, so the existing sweep behavior does not change. */
export const ghScm = (d: Deps, repo: string): Scm => {
  const list = <T>(kind: ItemKind, state: "all" | "open", fields: string): Promise<T[]> =>
    ghList<T>(d, [
      kind,
      "list",
      "--repo",
      repo,
      "--state",
      state === "all" ? "all" : "open",
      "--limit",
      SWEEP_LIMIT,
      "--json",
      fields,
    ]);

  return {
    kind: "gh",
    repo,
    listIssues: (state) => list<SweepItem>("issue", state, ITEM_FIELDS),
    listPrs: (state) => list<SweepItem>("pr", state, ITEM_FIELDS),
    listStalePrs: () => list<StalePr>("pr", "open", "number,title,createdAt,updatedAt,comments,reviews"),
    listStaleIssues: () => list<StaleIssue>("issue", "open", "number,title,createdAt,updatedAt,labels,comments"),
    ensureLabels: async (labels: readonly LabelSpec[]) => {
      for (const label of labels) {
        const r = await d.exec("gh", [
          "label",
          "create",
          label.name,
          "--repo",
          repo,
          "--color",
          label.color,
          "--description",
          label.description,
        ]);
        if (r.code !== 0 && !/already exists/i.test(`${r.stderr}${r.stdout}`))
          throw new Error(`gh label create ${label.name} failed: ${(r.stderr || r.stdout).trim()}`);
      }
    },
    editLabels: async (kind: ItemKind, number: number, add: string | undefined, remove: readonly string[]) => {
      const argv = [kind, "edit", String(number), "--repo", repo];
      if (add !== undefined) argv.push("--add-label", add);
      for (const name of remove) argv.push("--remove-label", name);
      await ghText(d, argv);
    },
    commentPr: async (number: number, body: string) => {
      await ghText(d, ["pr", "comment", String(number), "--repo", repo, "--body", body]);
    },
    closePr: async (number: number, body: string) => {
      await ghText(d, ["pr", "close", String(number), "--repo", repo, "--comment", body]);
    },
    addIssueLabel: async (number: number, label: string) => {
      await ghText(d, ["issue", "edit", String(number), "--repo", repo, "--add-label", label]);
    },
  };
};
