import { describe, expect, test } from "bun:test";
import { parse } from "../src/cli-args.ts";
import { normaliseLabel, planLabel, runLabels, statusLabelsOf } from "../src/labels.ts";
import { Refusal } from "../src/refusal.ts";
import { repoFromRemote } from "../src/repo-policy.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const item = (state: string, labels: string[]) => ({
  number: 7,
  title: "Fix login",
  state,
  labels: labels.map((name) => ({ name })),
});

describe("status label selection", () => {
  test("label names normalise case and spaces around the colon", () => {
    expect(normaliseLabel(" Status : In-Progress ")).toBe("status:in-progress");
    expect(normaliseLabel("STATUS:READY")).toBe("status:ready");
  });

  test("statusLabelsOf maps every variant to its canonical state and ignores other labels", () => {
    expect(statusLabelsOf([{ name: "Status: Ready" }, { name: "status:blocked" }, { name: "bug" }])).toEqual([
      { canonical: "status:ready", actual: "Status: Ready" },
      { canonical: "status:blocked", actual: "status:blocked" },
    ]);
  });

  test("an item with no status label starts at triage when open and done when closed", () => {
    expect(planLabel("issue", item("OPEN", ["bug"]))).toMatchObject({
      kind: "issue",
      add: "status:triage",
      remove: [],
    });
    expect(planLabel("pr", item("MERGED", []))).toMatchObject({ kind: "pr", add: "status:done", remove: [] });
    expect(planLabel("pr", item("CLOSED", []))).toMatchObject({ add: "status:done" });
  });

  test("one status label is left alone, two are cut down by precedence", () => {
    expect(planLabel("issue", item("OPEN", ["status:ready"]))).toBeUndefined();
    const blocked = planLabel("pr", item("OPEN", ["status:ready", "status:blocked"]))!;
    expect(blocked).toMatchObject({ remove: ["status:ready"] });
    expect(blocked.add).toBeUndefined();
    const triaged = planLabel("issue", item("OPEN", ["Status: Ready", "status:blocked", "status:triage"]))!;
    expect(triaged).toMatchObject({ remove: ["Status: Ready", "status:triage"] });
    expect(triaged.add).toBeUndefined();
    const owned = planLabel("issue", item("OPEN", ["status:triage", "status:in-progress"]))!;
    expect(owned).toMatchObject({ remove: ["status:triage"] });
    expect(owned.add).toBeUndefined();
  });

  test("a closed item with several labels keeps done, and an existing spelling is reused", () => {
    const done = planLabel("pr", item("CLOSED", ["status:in-progress", "status:done"]))!;
    expect(done).toMatchObject({ remove: ["status:in-progress"] });
    expect(done.add).toBeUndefined();
    expect(planLabel("pr", item("MERGED", ["status:in-progress", "status:ready"]))).toMatchObject({
      add: "status:done",
      remove: ["status:in-progress", "status:ready"],
    });
    const spelled = planLabel("pr", item("OPEN", ["Status: Blocked", "status:ready"]))!;
    expect(spelled).toMatchObject({ remove: ["status:ready"] });
    expect(spelled.add).toBeUndefined();
  });

  test("the plan is idempotent: applying it leaves exactly one status label", () => {
    const first = item("OPEN", ["status:ready", "status:blocked"]);
    const plan = planLabel("pr", first)!;
    const labels = first.labels.filter((l) => !plan.remove.includes(l.name));
    if (plan.add !== undefined) labels.push({ name: plan.add });
    expect(planLabel("pr", { ...first, labels })).toBeUndefined();
  });

  test("a github remote names the fallback repo; other hosts do not", () => {
    expect(repoFromRemote("git@github.com:asdfqwerzxcc/dori-superagent.git\n")).toBe("asdfqwerzxcc/dori-superagent");
    expect(repoFromRemote("https://github.com/asdfqwerzxcc/dori-superagent")).toBe("asdfqwerzxcc/dori-superagent");
    expect(repoFromRemote("https://gitlab.com/a/b.git")).toBeUndefined();
  });
});

const ghFor =
  (issues: unknown[], prs: unknown[]) =>
  (argv: readonly string[]): { code: number; stdout: string } => {
    if (argv[1] !== "list") return { code: 0, stdout: "" };
    return { code: 0, stdout: JSON.stringify(argv[0] === "issue" ? issues : prs) };
  };

const REPO = "asdfqwerzxcc/dori-superagent";

describe("dori labels", () => {
  test("a dry run plans work and never calls a mutating gh verb", async () => {
    const w = new World();
    w.gh = ghFor([{ number: 1, title: "Broken login", state: "OPEN", labels: [] }], []);
    const { code, out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("LABEL issue#1 add status:triage");
    expect(out).toContain(`LABELS ${REPO} items=1 changes=1 dry-run`);
    expect(w.calls.filter((c) => c.cmd === "gh" && (c.argv[1] === "edit" || c.argv[1] === "create"))).toEqual([]);
  });

  test("--apply creates the five labels and edits only the broken item", async () => {
    const w = new World();
    w.gh = ghFor(
      [],
      [{ number: 4, title: "Old PR", state: "OPEN", labels: [{ name: "status:ready" }, { name: "status:blocked" }] }],
    );
    const { out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO, "--apply"])));
    expect(out).toContain("changes=1 applied");
    const calls = w.calls.filter((c) => c.cmd === "gh");
    expect(calls.filter((c) => c.argv[1] === "create")).toHaveLength(5);
    expect(calls.find((c) => c.argv[1] === "edit")!.argv).toEqual([
      "pr",
      "edit",
      "4",
      "--repo",
      REPO,
      "--remove-label",
      "status:ready",
    ]);
  });

  test("a repo with its issue tracker disabled still sweeps pull requests", async () => {
    const w = new World();
    w.gh = (argv) => {
      if (argv[1] !== "list") return { code: 0, stdout: "" };
      if (argv[0] === "issue") return { code: 1, stdout: "the repository has disabled issues" };
      return { code: 0, stdout: JSON.stringify([{ number: 2, title: "Orphan PR", state: "OPEN", labels: [] }]) };
    };
    const { code, out } = await captureIo(() => runLabels(w.deps(), parse(["labels", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("NOTE issues are disabled");
    expect(out).toContain("LABEL pr#2 add status:triage");
  });

  test("an unlisted repo is read-only: dry runs work, --apply is refused before gh runs", async () => {
    const w = new World();
    w.gh = ghFor([], []);
    const d = w.deps();
    const { out } = await captureIo(() => runLabels(d, parse(["labels", "--repo", "acme/other"])));
    expect(out).toContain("dry-run");
    w.calls.length = 0;
    await expect(runLabels(d, parse(["labels", "--repo", "acme/other", "--apply"]))).rejects.toThrow(Refusal);
    expect(w.calls).toEqual([]);
  });
});
