import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { Refusal } from "../src/refusal.ts";
import { CLOSE_MARKER, NUDGE_MARKER, runStale } from "../src/stale.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const REPO = "gitlab.company.local/team/app";
const HOST = "gitlab.company.local";
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

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

const writes = (w: World) => w.calls.filter((c) => c.cmd === "glab" && flag(c.argv, "--method") !== "GET");

const glabFor = (mrs: unknown[], issues: unknown[], notes: Record<string, unknown[]> = {}) => {
  return (argv: readonly string[]): Reply => {
    const path = argv[1] ?? "";
    const method = flag(argv, "--method");
    if (argv[2] === "--hostname" && argv[3] !== HOST) return { code: 1, stdout: "", stderr: "wrong host" };
    if (method !== "GET") return json({});
    if (path.endsWith("/notes")) return json(notes[path] ?? []);
    if (path.endsWith("/merge_requests")) return json(mrs);
    if (path.endsWith("/issues")) return json(issues);
    if (path.endsWith("/labels")) return json([]);
    return json({});
  };
};

const world = (mrs: unknown[], issues: unknown[], notes: Record<string, unknown[]> = {}) => {
  const w = new World();
  w.clock = NOW;
  w.glab = glabFor(mrs, issues, notes);
  return { w, d: w.deps() };
};

const policy = { allow: [REPO], readOnly: [] };

describe("dori stale on GitLab", () => {
  test("a dry run plans MR nudges, an MR close, and issue needs-info without writing", async () => {
    const { w, d } = world(
      [
        { iid: 8, title: "Fix login", created_at: daysAgo(8), updated_at: daysAgo(8), user_notes_count: 0 },
        { iid: 9, title: "Old MR", created_at: daysAgo(20), updated_at: daysAgo(20), user_notes_count: 1 },
      ],
      [{ iid: 6, title: "Docs", created_at: daysAgo(20), updated_at: daysAgo(20), labels: [], user_notes_count: 0 }],
      {
        "projects/team%2Fapp/merge_requests/9/notes": [
          { body: "changed the label", system: true, created_at: daysAgo(2) },
        ],
      },
    );
    const { code, out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("STALE nudge pr#8 age=8d");
    expect(out).toContain("STALE close pr#9 age=20d");
    expect(out).toContain("STALE needs-info issue#6 age=20d");
    expect(out).toContain(`STALE ${REPO} prs=2 issues=1 actions=3 dry-run`);
    expect(writes(w)).toEqual([]);
    expect(existsSync(join(d.store.root, "state", "stale-audit.jsonl"))).toBe(false);
    const notesCall = w.calls.find((c) => c.argv[1]?.endsWith("/merge_requests/9/notes"))!;
    expect(flag(notesCall.argv, "--hostname")).toBe(HOST);
    expect(notesCall.argv).toContain("--paginate");
  });

  test("a system note is not movement, so an old MR still closes", async () => {
    const { d } = world(
      [{ iid: 9, title: "Old MR", created_at: daysAgo(20), updated_at: daysAgo(20), user_notes_count: 1 }],
      [],
      {
        "projects/team%2Fapp/merge_requests/9/notes": [
          { body: "added 1 commit", system: true, created_at: daysAgo(1) },
        ],
      },
    );
    const { out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO])));
    expect(out).toContain("STALE close pr#9 age=20d");
  });

  test("a previous nudge does not reset the close clock", async () => {
    const { d } = world(
      [{ iid: 8, title: "Fix login", created_at: daysAgo(15), updated_at: daysAgo(4), user_notes_count: 1 }],
      [],
      {
        "projects/team%2Fapp/merge_requests/8/notes": [
          { body: `${NUDGE_MARKER}\nstill planned?`, created_at: daysAgo(4) },
        ],
      },
    );
    const { out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO])));
    expect(out).toContain("STALE close pr#8 age=15d");
    expect(out).not.toContain("STALE nudge pr#8");
  });

  test("--apply nudges, closes with a marked note, labels the issue, and audits all three", async () => {
    const { w, d } = world(
      [
        { iid: 8, title: "Fix login", created_at: daysAgo(8), updated_at: daysAgo(8), user_notes_count: 0 },
        { iid: 9, title: "Old MR", created_at: daysAgo(20), updated_at: daysAgo(20), user_notes_count: 0 },
      ],
      [{ iid: 6, title: "Docs", created_at: daysAgo(20), updated_at: daysAgo(20), labels: [], user_notes_count: 0 }],
    );
    const { out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO, "--apply"]), policy));
    expect(out).toContain("actions=3 applied");

    const calls = w.calls.filter((c) => c.cmd === "glab");
    const nudge = calls.find(
      (c) => c.argv[1] === "projects/team%2Fapp/merge_requests/8/notes" && flag(c.argv, "--method") === "POST",
    )!;
    expect(fields(nudge.argv)["body"]).toContain(NUDGE_MARKER);
    expect(fields(nudge.argv)["body"]).toContain("If this MR is still planned");

    const closeNotes = calls.find(
      (c) => c.argv[1] === "projects/team%2Fapp/merge_requests/9/notes" && flag(c.argv, "--method") === "POST",
    )!;
    expect(fields(closeNotes.argv)["body"]).toContain(CLOSE_MARKER);
    const close = calls.find(
      (c) => c.argv[1] === "projects/team%2Fapp/merge_requests/9" && flag(c.argv, "--method") === "PUT",
    )!;
    expect(fields(close.argv)).toEqual({ state_event: "close" });

    const label = calls.find((c) => c.argv[1] === "projects/team%2Fapp/labels" && flag(c.argv, "--method") === "POST")!;
    expect(fields(label.argv)["name"]).toBe("needs-info");
    const issue = calls.find(
      (c) => c.argv[1] === "projects/team%2Fapp/issues/6" && flag(c.argv, "--method") === "PUT",
    )!;
    expect(fields(issue.argv)).toEqual({ add_labels: "needs-info" });

    const audit = readFileSync(join(d.store.root, "state", "stale-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit).toHaveLength(3);
    expect(audit.every((r) => r.ok === true && r.repo === REPO)).toBe(true);
    expect(audit.map((r) => r.action).sort()).toEqual(["close", "needs-info", "nudge"]);
  });

  test("a 403 on issues is a note for stale too, and MR actions still run", async () => {
    const w = new World();
    w.clock = NOW;
    w.glab = (argv) => {
      const path = argv[1] ?? "";
      if (path.endsWith("/issues")) return { code: 1, stdout: "", stderr: '{"message":"403 Forbidden"}' };
      return json([
        { iid: 8, title: "Fix login", created_at: daysAgo(8), updated_at: daysAgo(8), user_notes_count: 0 },
      ]);
    };
    const { code, out } = await captureIo(() => runStale(w.deps(), parse(["stale", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("NOTE issues are disabled on this project");
    expect(out).toContain("STALE nudge pr#8 age=8d");
  });

  test("an unlisted GitLab repo is read-only and --apply is refused before glab runs", async () => {
    const { w, d } = world([], []);
    await expect(runStale(d, parse(["stale", "--repo", REPO, "--apply"]), { allow: [], readOnly: [] })).rejects.toThrow(
      Refusal,
    );
    expect(w.calls).toEqual([]);
  });
});
