import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/cli-args.ts";
import { Refusal } from "../src/refusal.ts";
import {
  CLOSE_MARKER,
  NUDGE_MARKER,
  ageInDays,
  lastMovementAt,
  planIssue,
  planPr,
  planStale,
  runStale,
  type StaleIssue,
  type StalePr,
} from "../src/stale.ts";
import { World } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

const NOW = Date.parse("2026-11-19T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

const pr = (over: Partial<StalePr> = {}): StalePr => {
  const createdAt = over.createdAt ?? daysAgo(30);
  return {
    number: 3,
    title: "Fix login",
    createdAt,
    updatedAt: createdAt,
    comments: [],
    reviews: [],
    ...over,
  };
};
const issue = (over: Partial<StaleIssue> = {}): StaleIssue => {
  const createdAt = over.createdAt ?? daysAgo(30);
  return { number: 5, title: "Docs", createdAt, updatedAt: createdAt, labels: [], comments: [], ...over };
};
const opts = { now: NOW, daysPr: 14, daysComment: 7 };

describe("stale movement", () => {
  test("the latest comment, update or review is the last movement", () => {
    expect(lastMovementAt(pr({ comments: [{ body: "still here", createdAt: daysAgo(2) }] }))).toBe(NOW - 2 * DAY);
    expect(lastMovementAt(pr({ createdAt: daysAgo(30), updatedAt: daysAgo(4) }))).toBe(NOW - 4 * DAY);
    expect(lastMovementAt(pr({ reviews: [{ submittedAt: daysAgo(1) }] }))).toBe(NOW - DAY);
    expect(lastMovementAt(issue({ comments: [{ body: "thinking", createdAt: daysAgo(3) }] }))).toBe(NOW - 3 * DAY);
  });

  test("a dori nudge does not count as movement, so the close clock keeps running", () => {
    const nudged = pr({
      createdAt: daysAgo(20),
      updatedAt: daysAgo(2),
      comments: [{ body: `${NUDGE_MARKER}\nplease`, createdAt: daysAgo(2) }],
    });
    expect(lastMovementAt(nudged)).toBe(NOW - 20 * DAY);
    expect(planPr(nudged, opts)).toMatchObject({ action: "close", ageDays: 20 });
  });

  test("an update after the nudge is movement again", () => {
    const active = pr({
      createdAt: daysAgo(20),
      updatedAt: daysAgo(2),
      comments: [{ body: NUDGE_MARKER, createdAt: daysAgo(5) }],
    });
    expect(lastMovementAt(active)).toBe(NOW - 2 * DAY);
    expect(planPr(active, opts)).toBeUndefined();
  });

  test("age floor counts whole days, so the threshold is reached exactly", () => {
    expect(ageInDays(NOW - 7 * DAY, NOW)).toBe(7);
    expect(ageInDays(NOW - 7 * DAY + 1, NOW)).toBe(6);
  });
});

describe("stale thresholds", () => {
  test("PR: nothing before the comment window, one nudge at it, close at the close window", () => {
    expect(planPr(pr({ createdAt: daysAgo(6) }), opts)).toBeUndefined();
    expect(planPr(pr({ createdAt: daysAgo(7) }), opts)).toMatchObject({ action: "nudge", ageDays: 7 });
    expect(planPr(pr({ createdAt: daysAgo(14) }), opts)).toMatchObject({ action: "close", ageDays: 14 });
    expect(planPr(pr({ createdAt: daysAgo(30) }), opts)).toMatchObject({ action: "close", ageDays: 30 });
  });

  test("PR movement after creation postpones both thresholds", () => {
    expect(planPr(pr({ createdAt: daysAgo(30), updatedAt: daysAgo(3) }), opts)).toBeUndefined();
    expect(planPr(pr({ createdAt: daysAgo(30), reviews: [{ submittedAt: daysAgo(2) }] }), opts)).toBeUndefined();
  });

  test("one nudge per stale stretch: no second comment, but close still arrives", () => {
    expect(
      planPr(
        pr({
          createdAt: daysAgo(10),
          updatedAt: daysAgo(2),
          comments: [{ body: NUDGE_MARKER, createdAt: daysAgo(2) }],
        }),
        opts,
      ),
    ).toBeUndefined();
    expect(
      planPr(
        pr({
          createdAt: daysAgo(15),
          updatedAt: daysAgo(4),
          comments: [{ body: NUDGE_MARKER, createdAt: daysAgo(4) }],
        }),
        opts,
      ),
    ).toMatchObject({ action: "close" });
  });

  test("the comment window is configurable", () => {
    const custom = { now: NOW, daysPr: 10, daysComment: 2 };
    expect(planPr(pr({ createdAt: daysAgo(3) }), custom)).toMatchObject({ action: "nudge", ageDays: 3 });
    expect(planPr(pr({ createdAt: daysAgo(3) }), opts)).toBeUndefined();
  });

  test("issues get needs-info at 14 days and are never closed", () => {
    expect(planIssue(issue({ createdAt: daysAgo(13) }), opts)).toBeUndefined();
    expect(planIssue(issue({ createdAt: daysAgo(14) }), opts)).toMatchObject({ action: "needs-info", ageDays: 14 });
    expect(planIssue(issue({ createdAt: daysAgo(400) }), opts)).toMatchObject({ action: "needs-info" });
    expect(planIssue(issue({ createdAt: daysAgo(400), labels: [{ name: "Needs-Info" }] }), opts)).toBeUndefined();
  });

  test("the full plan sorts issues before PRs and keeps both actions", () => {
    const actions = planStale([pr({ number: 9 })], [issue({ number: 2 })], opts);
    expect(actions.map((a) => `${a.action} ${a.kind}#${a.number}`)).toEqual(["needs-info issue#2", "close pr#9"]);
  });
});

const REPO = "asdfqwerzxcc/dori-superagent";

const ghFor =
  (prs: unknown[], issues: unknown[]) =>
  (argv: readonly string[]): { code: number; stdout: string } => {
    if (argv[1] !== "list") return { code: 0, stdout: "" };
    return { code: 0, stdout: JSON.stringify(argv[0] === "pr" ? prs : issues) };
  };

const world = (prs: unknown[], issues: unknown[]) => {
  const w = new World();
  w.clock = NOW;
  w.gh = ghFor(prs, issues);
  return { w, d: w.deps() };
};

const mutations = (w: World) =>
  w.calls.filter((c) => c.cmd === "gh" && ["comment", "close", "edit", "create"].includes(c.argv[1] ?? ""));

describe("dori stale", () => {
  test("a dry run prints the plan and writes nothing, not even the audit log", async () => {
    const { w, d } = world([pr({ number: 8, createdAt: daysAgo(8) })], [issue({ number: 6, createdAt: daysAgo(20) })]);
    const { code, out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO])));
    expect(code).toBe(0);
    expect(out).toContain("STALE nudge pr#8 age=8d");
    expect(out).toContain("STALE needs-info issue#6 age=20d");
    expect(out).toContain(`STALE ${REPO} prs=1 issues=1 actions=2 dry-run`);
    expect(mutations(w)).toEqual([]);
    expect(existsSync(join(d.store.root, "state", "stale-audit.jsonl"))).toBe(false);
  });

  test("--apply comments, closes with a marked reason, labels the issue, and audits both", async () => {
    const { w, d } = world([pr({ number: 8, createdAt: daysAgo(20) })], [issue({ number: 6, createdAt: daysAgo(20) })]);
    const { out } = await captureIo(() => runStale(d, parse(["stale", "--repo", REPO, "--apply"])));
    expect(out).toContain("actions=2 applied");
    const calls = w.calls.filter((c) => c.cmd === "gh");
    const close = calls.find((c) => c.argv[0] === "pr" && c.argv[1] === "close")!;
    expect(close.argv).toContain("--comment");
    expect(close.argv.join(" ")).toContain(CLOSE_MARKER);
    expect(calls.find((c) => c.argv[0] === "issue" && c.argv[1] === "edit")!.argv).toContain("needs-info");
    expect(calls.filter((c) => c.argv[0] === "label" && c.argv[1] === "create")).toHaveLength(1);
    const audit = readFileSync(join(d.store.root, "state", "stale-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit).toHaveLength(2);
    expect(audit.every((r) => r.ok === true && r.repo === REPO)).toBe(true);
    expect(audit.map((r) => r.action).sort()).toEqual(["close", "needs-info"]);
  });

  test("an unlisted repo is read-only and --apply is refused before gh runs", async () => {
    const { w, d } = world([], []);
    await expect(runStale(d, parse(["stale", "--repo", "acme/other", "--apply"]))).rejects.toThrow(Refusal);
    expect(w.calls).toEqual([]);
  });

  test("threshold flags are validated before any gh call", async () => {
    const { w, d } = world([], []);
    await expect(runStale(d, parse(["stale", "--repo", REPO, "--days-pr", "0"]))).rejects.toThrow(Refusal);
    await expect(runStale(d, parse(["stale", "--repo", REPO, "--days-comment", "soon"]))).rejects.toThrow(Refusal);
    expect(w.calls).toEqual([]);
  });
});
