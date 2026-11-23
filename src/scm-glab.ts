import type { Deps } from "./harness.ts";
import type { ExecResult } from "./runtime/exec.ts";
import {
  normaliseLabel,
  type Comment,
  type ItemKind,
  type Label,
  type LabelSpec,
  type Scm,
  type StaleIssue,
  type StalePr,
  type SweepItem,
} from "./scm.ts";

type Json = Record<string, unknown>;
type Fields = Readonly<Record<string, string | number>>;
type Method = "GET" | "POST" | "PUT";

const asRecord = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;

const stateOf = (value: unknown): string => {
  const state = String(value ?? "").toLowerCase();
  return state === "opened" ? "OPEN" : state === "merged" ? "MERGED" : "CLOSED";
};

const labelsOf = (value: unknown): Label[] =>
  Array.isArray(value)
    ? value.flatMap((raw) => {
        const name = typeof raw === "string" ? raw : asRecord(raw)?.["name"];
        return typeof name === "string" ? [{ name }] : [];
      })
    : [];

const itemOf = (raw: Json): SweepItem => ({
  number: Number(raw["iid"]),
  title: String(raw["title"] ?? ""),
  state: stateOf(raw["state"]),
  labels: labelsOf(raw["labels"]),
});

const hasNotes = (raw: Json): boolean => raw["user_notes_count"] === undefined || Number(raw["user_notes_count"]) > 0;

const issuesDisabled = (e: unknown): boolean => e instanceof Error && /403\s+Forbidden/i.test(e.message);

const glabCall = async (
  d: Deps,
  host: string,
  path: string,
  opts: { readonly method?: Method; readonly fields?: Fields; readonly paginate?: boolean } = {},
): Promise<ExecResult> => {
  const argv = ["api", path, "--hostname", host, "--method", opts.method ?? "GET"];
  if (opts.paginate === true) argv.push("--paginate");
  for (const [key, value] of Object.entries(opts.fields ?? {})) argv.push("--raw-field", `${key}=${value}`);
  const r = await d.exec("glab", argv);
  if (r.code !== 0) throw new Error(`glab api ${path} failed: ${(r.stderr || r.stdout).trim()}`);
  return r;
};

const glabJson = async <T>(
  d: Deps,
  host: string,
  path: string,
  opts: { readonly method?: Method; readonly fields?: Fields; readonly paginate?: boolean } = {},
): Promise<T> => {
  const r = await glabCall(d, host, path, opts);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`glab api ${path} printed no JSON`);
  }
};

export const glabScm = (d: Deps, host: string, project: string): Scm => {
  const base = `projects/${encodeURIComponent(project)}`;
  const repo = `${host}/${project}`;

  const list = async (path: string, state: "all" | "open"): Promise<SweepItem[]> => {
    const raw = await glabJson<Json[]>(d, host, path, {
      fields: { state: state === "all" ? "all" : "opened", per_page: 100 },
      paginate: true,
    });
    return raw.map(itemOf);
  };

  const notes = async (itemPath: string): Promise<Comment[]> => {
    const raw = await glabJson<Json[]>(d, host, `${itemPath}/notes`, {
      fields: { per_page: 100, sort: "asc" },
      paginate: true,
    });
    return raw.flatMap((note) =>
      note["system"] === true || typeof note["body"] !== "string"
        ? []
        : [{ body: note["body"], createdAt: String(note["created_at"] ?? "") }],
    );
  };

  return {
    kind: "glab",
    repo,
    listIssues: async (state) => {
      try {
        return await list(`${base}/issues`, state);
      } catch (e) {
        if (issuesDisabled(e)) {
          console.log("NOTE issues are disabled on this project; only merge requests are swept");
          return [];
        }
        throw e;
      }
    },
    listPrs: (state) => list(`${base}/merge_requests`, state),
    listStalePrs: async () => {
      const raw = await glabJson<Json[]>(d, host, `${base}/merge_requests`, {
        fields: { state: "opened", per_page: 100 },
        paginate: true,
      });
      const out: StalePr[] = [];
      for (const mr of raw) {
        const number = Number(mr["iid"]);
        const comments = hasNotes(mr) ? await notes(`${base}/merge_requests/${number}`) : [];
        out.push({
          number,
          title: String(mr["title"] ?? ""),
          createdAt: String(mr["created_at"] ?? ""),
          updatedAt: String(mr["updated_at"] ?? ""),
          comments,
          reviews: [],
        });
      }
      return out;
    },
    listStaleIssues: async () => {
      let raw: Json[];
      try {
        raw = await glabJson<Json[]>(d, host, `${base}/issues`, {
          fields: { state: "opened", per_page: 100 },
          paginate: true,
        });
      } catch (e) {
        if (issuesDisabled(e)) {
          console.log("NOTE issues are disabled on this project; only merge requests are swept");
          return [];
        }
        throw e;
      }
      const out: StaleIssue[] = [];
      for (const issue of raw) {
        const number = Number(issue["iid"]);
        const comments = hasNotes(issue) ? await notes(`${base}/issues/${number}`) : [];
        out.push({
          number,
          title: String(issue["title"] ?? ""),
          createdAt: String(issue["created_at"] ?? ""),
          updatedAt: String(issue["updated_at"] ?? ""),
          labels: labelsOf(issue["labels"]),
          comments,
        });
      }
      return out;
    },
    ensureLabels: async (labels: readonly LabelSpec[]) => {
      const raw = await glabJson<Json[]>(d, host, `${base}/labels`, {
        fields: { per_page: 100 },
        paginate: true,
      });
      const have = new Set(
        raw.flatMap((label) => {
          const name = label["name"];
          return typeof name === "string" ? [normaliseLabel(name)] : [];
        }),
      );
      for (const label of labels) {
        const key = normaliseLabel(label.name);
        if (have.has(key)) continue;
        try {
          await glabCall(d, host, `${base}/labels`, {
            method: "POST",
            fields: {
              name: label.name,
              color: label.color.startsWith("#") ? label.color : `#${label.color}`,
              description: label.description,
            },
          });
          have.add(key);
        } catch (e) {
          if (!(e instanceof Error) || !/already exists|409/i.test(e.message)) throw e;
          have.add(key);
        }
      }
    },
    editLabels: async (kind: ItemKind, number: number, add: string | undefined, remove: readonly string[]) => {
      const fields: Record<string, string> = {};
      if (add !== undefined) fields["add_labels"] = add;
      if (remove.length > 0) fields["remove_labels"] = remove.join(",");
      if (Object.keys(fields).length === 0) return;
      const path = `${base}/${kind === "issue" ? "issues" : "merge_requests"}/${number}`;
      await glabCall(d, host, path, { method: "PUT", fields });
    },
    commentPr: async (number: number, body: string) => {
      await glabCall(d, host, `${base}/merge_requests/${number}/notes`, { method: "POST", fields: { body } });
    },
    closePr: async (number: number, body: string) => {
      await glabCall(d, host, `${base}/merge_requests/${number}/notes`, { method: "POST", fields: { body } });
      await glabCall(d, host, `${base}/merge_requests/${number}`, { method: "PUT", fields: { state_event: "close" } });
    },
    addIssueLabel: async (number: number, label: string) => {
      await glabCall(d, host, `${base}/issues/${number}`, { method: "PUT", fields: { add_labels: label } });
    },
  };
};
