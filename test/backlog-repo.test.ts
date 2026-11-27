import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backlogAdd } from "../src/backlog.ts";
import { startLane } from "../src/lanes.ts";
import { loopTick } from "../src/loop.ts";
import { fakeGit } from "./fake-git.ts";
import type { World } from "./fake.ts";
import { setup } from "./loop-setup.ts";

/** fakeGit with `rev-parse --show-toplevel` answering the checkout it was pointed at, so a lane records the hint. */
function gitAtCwd(w: World): void {
  const head = "a".repeat(40);
  const inner = w.git;
  w.git = (argv, stdin) => {
    const cwd = argv[0] === "-C" ? argv[1] : undefined;
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: `${cwd}\n` };
    if (args[0] === "rev-parse" && args[1] === "HEAD") return { code: 0, stdout: `${head}\n` };
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
    gitAtCwd(w);
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
    const { d } = setup();
    const repo = join(d.store.root, "teams", "omo-stats");
    mkdirSync(repo, { recursive: true });
    const brief = join(d.store.root, "stats.md");
    writeFileSync(brief, "# Budgets\n\nSee teams/omo-stats/budgets.\n");
    expect((await startLane(d, "stats-ok", brief, { cwd: repo, group: "w1" })).cwd).toBe(repo);
    await expect(startLane(d, "stats-wrong", brief, { cwd: d.store.root, group: "w1" })).rejects.toThrow(
      "belongs to teams/omo-stats",
    );
    expect(d.store.lane("stats-wrong")).toBeUndefined();
    const declared = join(d.store.root, "stats-declared.md");
    writeFileSync(declared, `---\nrepo: ${repo}\n---\n\n# Budgets\n\nSee teams/omo-stats/budgets.\n`);
    await expect(startLane(d, "stats-elsewhere", declared, { cwd: d.store.root, group: "w1" })).rejects.toThrow(
      `declares repo ${repo}`,
    );
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
