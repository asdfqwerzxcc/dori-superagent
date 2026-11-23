import { describe, expect, test } from "bun:test";
import { parse } from "../src/cli-args.ts";
import { runLabels } from "../src/labels.ts";
import { Refusal } from "../src/refusal.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const REPO = "gitlab.company.local/team/app";
const HOST = "gitlab.company.local";

type Reply = { code: number; stdout: string; stderr?: string };
const json = (body: unknown): Reply => ({ code: 0, stdout: JSON.stringify(body) });

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};

const fields = (argv: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--raw-field") continue;
    const pair = argv[i + 1] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
};

const mutating = (w: World) => w.calls.filter((c) => c.cmd === "glab" && flag(c.argv, "--method") !== "GET");

const glabFor =
  (issues: unknown[], mrs: unknown[], labels: unknown[] = []) =>
  (argv: readonly string[]): Reply => {
    const path = argv[1] ?? "";
    if (argv[2] !== "--hostname") return { code: 1, stdout: "", stderr: "missing --hostname" };
    if (path.endsWith("/issues")) return json(issues);
    if (path.endsWith("/merge_requests")) return json(mrs);
    if (path.endsWith("/labels")) return json(labels);
    return json({});
  };

describe("dori labels on GitLab", () => {
  test("a dry run plans through glab api and never mutates", async () => {
    const w = new World();
    w.glab = glabFor(
      [{ iid: 1, title: "Broken login", state: "opened", labels: [] }],
      [{ iid: 4, title: "Old MR", state: "opened", labels: ["status:ready", "status:blocked"] }],
    );
    const { code, out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("LABEL issue#1 add status:triage (Broken login)");
    expect(out).toContain("LABEL pr#4 remove status:ready (Old MR)");
    expect(out).toContain(`LABELS ${REPO} items=2 changes=2 dry-run`);
    expect(mutating(w)).toEqual([]);

    const list = w.calls.filter((c) => c.cmd === "glab");
    expect(list.map((c) => c.argv[1])).toEqual(["projects/team%2Fapp/issues", "projects/team%2Fapp/merge_requests"]);
    for (const call of list) {
      expect(flag(call.argv, "--hostname")).toBe(HOST);
      expect(call.argv).toContain("--paginate");
      expect(fields(call.argv)).toMatchObject({ state: "all", per_page: "100" });
    }
  });

  test("--apply creates missing labels and edits only the broken items", async () => {
    const w = new World();
    w.glab = glabFor(
      [{ iid: 1, title: "Broken login", state: "opened", labels: [] }],
      [{ iid: 4, title: "Old MR", state: "opened", labels: ["status:ready", "status:blocked"] }],
      [{ name: "status:triage" }],
    );
    const { out } = await captureIo(() =>
      runLabels(w.deps(), parse(["labels", "--repo", REPO, "--apply"]), {
        allow: [REPO.toLowerCase()],
        readOnly: [],
      }),
    );
    expect(out).toContain("changes=2 applied");
    const calls = w.calls.filter((c) => c.cmd === "glab");
    const creates = calls.filter(
      (c) => c.argv[1] === "projects/team%2Fapp/labels" && flag(c.argv, "--method") === "POST",
    );
    expect(creates).toHaveLength(4);
    expect(creates.map((c) => fields(c.argv)["name"]).sort()).toEqual([
      "status:blocked",
      "status:done",
      "status:in-progress",
      "status:ready",
    ]);
    expect(fields(creates[0]!.argv)).toMatchObject({ color: expect.any(String), description: expect.any(String) });
    expect(fields(creates[0]!.argv)["color"]).toMatch(/^#[0-9a-f]{6}$/i);

    const issue = calls.find((c) => c.argv[1] === "projects/team%2Fapp/issues/1")!;
    expect(flag(issue.argv, "--method")).toBe("PUT");
    expect(fields(issue.argv)).toEqual({ add_labels: "status:triage" });

    const mr = calls.find((c) => c.argv[1] === "projects/team%2Fapp/merge_requests/4")!;
    expect(flag(mr.argv, "--method")).toBe("PUT");
    expect(fields(mr.argv)).toEqual({ remove_labels: "status:ready" });
  });

  test("an unlisted GitLab repo is read-only: dry runs work, --apply is refused before glab runs", async () => {
    const w = new World();
    w.glab = glabFor([], []);
    const policy = { allow: [], readOnly: [] };
    const { out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO]), policy));
    expect(out).toContain("dry-run");
    w.calls.length = 0;
    await expect(runLabels(w.deps(), parse(["labels", "--repo", REPO, "--apply"]), policy)).rejects.toThrow(Refusal);
    expect(w.calls).toEqual([]);
  });

  test("a 403 on issues is a note, not a failed sweep, and merge requests still run", async () => {
    const w = new World();
    w.glab = (argv) => {
      const path = argv[1] ?? "";
      if (path.endsWith("/issues")) return { code: 1, stdout: "", stderr: '{"message":"403 Forbidden"}' };
      return json([{ iid: 2, title: "Orphan MR", state: "opened", labels: [] }]);
    };
    const { code, out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("NOTE issues are disabled on this project");
    expect(out).toContain("LABEL pr#2 add status:triage");
  });
});
