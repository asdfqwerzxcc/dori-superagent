import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { fakeGit } from "./fake-git.ts";
import type { World } from "./fake.ts";
import { setup } from "./loop-setup.ts";

const DESIGN_ORIGIN = "https://github.com/asdfqwerzxcc/dori-design-system.git";
const OMO_STATS_ORIGIN = "https://github.com/asdfqwerzxcc/omo-stats.git";
const DORI_ORIGIN = "https://github.com/sisyphuslabs/dori-superagent.git";

/** fakeGit with a per-path toplevel and origin, so identity is the remote and never a path suffix. */
function gitAtCwd(w: World, origins: Record<string, string> = {}): void {
  const head = "a".repeat(40);
  const inner = w.git;
  w.git = (argv, stdin) => {
    const cwd = argv[0] === "-C" ? argv[1] : undefined;
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: `${cwd}\n` };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n` };
    if (args[0] === "remote" && args[1] === "get-url") {
      const url = cwd === undefined ? undefined : origins[cwd];
      if (url !== undefined) return { code: 0, stdout: `${url}\n` };
      return { code: 2, stdout: "", stderr: "no such remote" };
    }
    return inner(argv, stdin);
  };
}

describe("backlog repo hints", () => {
  test("an item with --repo starts its design brief in that checkout and logs the repo", async () => {
    const { w, d } = setup();
    const repo = join(d.store.root, "teams", "design");
    mkdirSync(repo, { recursive: true });
    const brief = join(d.store.root, "design-card.md");
    writeFileSync(brief, "# Card\n\nMatch the ds-v4/ reference.\n");
    const item = backlogAdd(d, "design-card", brief, { cwd: d.store.root, repo });
    expect(item.repo).toBe(repo);
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w, { [repo]: DESIGN_ORIGIN });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual(["design-card (p5)"]);
    const lane = d.store.lane("design-card")!;
    expect(lane.cwd).toBe(repo);
    expect(lane.repo).toBe(repo);
    expect(w.calls.some((c) => c.cmd === "git" && c.argv[0] === "-C" && c.argv[1] === repo)).toBe(true);
    expect(d.store.item("design-card")!.log.at(-1)).toMatchObject({
      kind: "start",
      text: `lane opened by the hourly loop (repo=${repo})`,
    });
  });

  test("a repo: line in the brief front-matter is stored, resolved beside the brief", () => {
    const { d } = setup();
    const dir = join(d.store.root, "briefs");
    mkdirSync(join(dir, "checkout"), { recursive: true });
    const brief = join(dir, "design-card.md");
    writeFileSync(brief, "---\nrepo: checkout\n---\n\n# Card\n");
    expect(backlogAdd(d, "front-matter", brief).repo).toBe(join(dir, "checkout"));
    const absolute = join(dir, "checkout");
    writeFileSync(brief, `---\nrepo: "${absolute}"\n---\n\n# Card\n`);
    expect(backlogAdd(d, "front-matter-abs", brief).repo).toBe(absolute);
  });

  test("the loop reads a front-matter hint for an item stored before the repo field existed", async () => {
    const { w, d, add } = setup();
    const repo = join(d.store.root, "teams", "design");
    mkdirSync(repo, { recursive: true });
    const item = add("old-item");
    writeFileSync(item.brief, `---\nrepo: ${repo}\n---\n\n# Card\n`);
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w);
    await loopTick(d, { force: true });
    expect(d.store.lane("old-item")!.cwd).toBe(repo);
    expect(d.store.item("old-item")!.log.at(-1)!.text).toContain(`repo=${repo}`);
  });

  test("a design brief without a hint is refused by the loop with the repo message", async () => {
    const { d } = setup();
    const brief = join(d.store.root, "design.md");
    writeFileSync(brief, "# Card\n\nMatch the ds-v4/ reference.\n");
    backlogAdd(d, "design-no-hint", brief, { cwd: d.store.root });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    const finding = run.findings.find((f) => f.startsWith("start design-no-hint failed"));
    expect(finding).toContain("names ds-v4/");
    expect(finding).toContain("teams/design");
    expect(finding).toContain("repo:");
    expect(d.store.lane("design-no-hint")).toBeUndefined();
    expect(d.store.item("design-no-hint")).toMatchObject({ status: "open", startFailures: 1 });
  });

  test("the right checkout passes the guard, and an ad-hoc start in the wrong one is refused", async () => {
    const { w, d } = setup();
    const repo = join(d.store.root, "teams", "omo-stats");
    mkdirSync(repo, { recursive: true });
    const brief = join(d.store.root, "stats.md");
    writeFileSync(brief, "# Budgets\n\nSee teams/omo-stats/budgets.\n");
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w, { [repo]: OMO_STATS_ORIGIN });
    expect((await startLane(d, "stats-ok", brief, { cwd: repo, group: "w1" })).cwd).toBe(repo);
    await expect(startLane(d, "stats-wrong", brief, { cwd: d.store.root, group: "w1" })).rejects.toThrow(
      "belongs to teams/omo-stats",
    );
    expect(d.store.lane("stats-wrong")).toBeUndefined();
    const declared = join(d.store.root, "plain-declared.md");
    writeFileSync(declared, `---\nrepo: ${repo}\n---\n\n# Plain\n`);
    await expect(startLane(d, "declared-elsewhere", declared, { cwd: d.store.root, group: "w1" })).rejects.toThrow(
      `declares repo ${repo}`,
    );
  });

  test("a repo hint does not bypass the team guard", async () => {
    const { w, d } = setup();
    const wrong = join(d.store.root, "dori-clone");
    mkdirSync(wrong, { recursive: true });
    const brief = join(d.store.root, "design-hinted.md");
    writeFileSync(brief, "# Card\n\nMatch the ds-v4/ reference.\n");
    backlogAdd(d, "design-wrong-hint", brief, { cwd: d.store.root, repo: wrong });
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w, { [wrong]: DORI_ORIGIN });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    const finding = run.findings.find((f) => f.startsWith("start design-wrong-hint failed"));
    expect(finding).toContain("names ds-v4/");
    expect(finding).toContain("belongs to teams/design");
    expect(finding).toContain("dori-superagent");
    expect(d.store.lane("design-wrong-hint")).toBeUndefined();
  });

  test("a design clone outside teams/design passes by its design origin", async () => {
    const { w, d } = setup();
    const clone = join(d.store.root, "design-clone");
    mkdirSync(clone, { recursive: true });
    const brief = join(d.store.root, "design-clone.md");
    writeFileSync(brief, "# Card\n\nMatch the ds-v4/ reference.\n");
    backlogAdd(d, "design-origin", brief, { cwd: d.store.root, repo: clone });
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w, { [clone]: DESIGN_ORIGIN });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual(["design-origin (p5)"]);
    expect(d.store.lane("design-origin")!.cwd).toBe(clone);
  });

  test("a nested dori checkout cannot pass by its path suffix", async () => {
    const { w, d } = setup();
    const nested = join(d.store.root, "teams", "design", "teams", "omo-stats");
    mkdirSync(nested, { recursive: true });
    const brief = join(d.store.root, "nested.md");
    writeFileSync(brief, "# Budgets\n\nSee teams/omo-stats/budgets.\n");
    backlogAdd(d, "nested-omo", brief, { cwd: d.store.root, repo: nested });
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w, { [nested]: DORI_ORIGIN });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    const finding = run.findings.find((f) => f.startsWith("start nested-omo failed"));
    expect(finding).toContain("belongs to teams/omo-stats");
    expect(finding).toContain("dori-superagent");
    expect(d.store.lane("nested-omo")).toBeUndefined();
  });

  test("a team checkout with no origin is refused", async () => {
    const { w, d } = setup();
    const repo = join(d.store.root, "teams", "design");
    mkdirSync(repo, { recursive: true });
    const brief = join(d.store.root, "design-no-origin.md");
    writeFileSync(brief, "# Card\n\nMatch the ds-v4/ reference.\n");
    backlogAdd(d, "design-no-origin", brief, { cwd: d.store.root, repo });
    fakeGit(w, { head: "a".repeat(40) });
    gitAtCwd(w);
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    const finding = run.findings.find((f) => f.startsWith("start design-no-origin failed"));
    expect(finding).toContain("has origin none");
    expect(d.store.lane("design-no-origin")).toBeUndefined();
  });

  test("a hint that is not a git checkout fails before a lane and never logs a start repo", async () => {
    const { d } = setup();
    const plain = join(d.store.root, "plain-dir");
    mkdirSync(plain, { recursive: true });
    const brief = join(d.store.root, "plain.md");
    writeFileSync(brief, "# Plain\n");
    backlogAdd(d, "not-git", brief, { cwd: d.store.root, repo: plain });
    const run = await loopTick(d, { force: true });
    expect(run.started).toEqual([]);
    const finding = run.findings.find((f) => f.startsWith("start not-git failed"));
    expect(finding).toContain("is not a git checkout");
    expect(d.store.lane("not-git")).toBeUndefined();
    const log = d.store.item("not-git")!.log;
    expect(log.some((e) => e.text.startsWith("lane opened"))).toBe(false);
    expect(log.at(-1)!.text).toStartWith("failed:");
    expect(existsSync(join(d.store.root, "worktrees", "not-git"))).toBe(false);
  });

  test("the loop logs repo=default when the item has no hint and the brief names no repo", async () => {
    const { d, add } = setup();
    add("plain");
    await loopTick(d, { force: true });
    expect(d.store.item("plain")!.log.at(-1)).toMatchObject({
      kind: "start",
      text: "lane opened by the hourly loop (repo=default)",
    });
  });
});
