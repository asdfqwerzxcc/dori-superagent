import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done } from "../src/lanes.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";
import type { Lane } from "../src/store-types.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

setDefaultTimeout(30_000);

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await spawnExec("git", ["-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

type FixtureOptions = {
  readonly merge?: boolean;
  readonly pane?: "working" | "idle" | "gone";
};

/**
 * A real repository with a READY lane: branch `lane/scenario` at the reviewed tip, a CLEAR receipt there, and (unless
 * `merge: false`) the PR landing as a merge commit on main, exactly the state `dori merge` leaves behind.
 */
async function fixture(opts: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "dori-done-landed-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.test");
  await git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git(repo, "add", "--", "base.txt");
  await git(repo, "commit", "-m", "base");
  const base = await git(repo, "rev-parse", "HEAD");
  const worktree = join(root, "lane-tree");
  await git(repo, "worktree", "add", "-b", "lane/scenario", worktree, base);
  writeFileSync(join(worktree, "work.txt"), "work\n");
  await git(worktree, "add", "--", "work.txt");
  await git(worktree, "commit", "-m", "the reviewed work");
  const tip = await git(worktree, "rev-parse", "HEAD");
  let merge: string | undefined;
  if (opts.merge !== false) {
    await git(repo, "merge", "--no-ff", "-m", "Merge pull request #1 from lane/scenario", "lane/scenario");
    merge = await git(repo, "rev-parse", "HEAD");
  }
  const lane: Lane = {
    key: "scenario",
    sessionRef: href("w1:p9"),
    paneId: "w1:p9",
    tabId: "",
    brief: join(home, "brief.md"),
    cwd: repo,
    worktree,
    repo,
    baseSha: base,
    tipSha: tip,
    status: "ready",
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    final: { text: "final", evidence: ["https://example.test/pull/1"], at: 1 },
    log: [{ at: 1, kind: "ready", text: "final" }],
  };
  const store = new Store(home);
  store.saveLane(lane);
  store.saveLaneReceipt({
    lane: "scenario",
    verdict: "CLEAR",
    base,
    tip,
    brief: join(home, "brief.md"),
    reviewer: "test",
    at: 1,
    summary: "reviewed before the merge",
  });
  const w = new World();
  if (opts.pane !== "gone") w.addPane("w1:p9", opts.pane ?? "idle");
  const d = { ...w.deps(), store, exec: spawnExec, now: () => Date.now() };
  return { d, store, w, repo, root, worktree, base, tip, merge };
}

describe("done after a PR landing", () => {
  test("a lane rebased onto the merge commit closes by the receipt on its parent", async () => {
    const { d, store, worktree, tip, merge } = await fixture({ pane: "gone" });
    if (merge === undefined) throw new Error("fixture did not merge the lane");
    // The observed dashboard-kpi-pattern state: `git rebase main` moved the already-merged branch onto the merge commit.
    await git(worktree, "rebase", "main");
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(merge);

    const { out } = await captureIo(() => main(["done", "scenario"], d));
    expect(out).toBe(`DONE scenario (CLEAR receipt lane_scenario@${tip} on the parent of merge commit ${merge})`);
    expect(store.lane("scenario")!.status).toBe("done");
    expect(store.lane("scenario")!.log.at(-1)!.text).toContain("parent of merge commit");
  });

  test("a lane moved past the merge closes by a receipt main already contains", async () => {
    const { d, store, worktree, repo, tip } = await fixture({ pane: "gone" });
    writeFileSync(join(repo, "later.txt"), "later\n");
    await git(repo, "add", "--", "later.txt");
    await git(repo, "commit", "-m", "later work on main");
    await git(worktree, "rebase", "main");

    const note = await done(d, "scenario");
    expect(note).toContain(`CLEAR receipt lane_scenario@${tip} already on main`);
    expect(store.lane("scenario")!.status).toBe("done");
  });

  test("a landed lane closes while its pane still runs follow-up work", async () => {
    const { d, store, w, tip } = await fixture({ pane: "working" });

    const note = await done(d, "scenario");
    expect(note).toContain("pane was working on a landed lane");
    expect(note).toContain(`lane/scenario@${tip.slice(0, 12)} is already on main`);
    expect(store.lane("scenario")!.status).toBe("done");
    expect(w.panes.has("w1:p9")).toBe(false);
  });

  test("an unlanded lane still refuses a working pane", async () => {
    const { d, store, w } = await fixture({ merge: false, pane: "working" });

    await expect(done(d, "scenario")).rejects.toThrow("pane is working; let it finish first");
    expect(store.lane("scenario")!.status).toBe("ready");
    expect(w.panes.has("w1:p9")).toBe(true);
  });

  test("a missing worktree closes on a receipt main contains, without rewriting it", async () => {
    const { d, store, repo, worktree, tip } = await fixture({ pane: "gone" });
    rmSync(worktree, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
    await git(repo, "branch", "-D", "lane/scenario");

    const note = await done(d, "scenario");
    expect(note).toContain(`is already on main (CLEAR receipt lane_scenario@${tip})`);
    expect(store.lane("scenario")!.status).toBe("done");
  });
});
