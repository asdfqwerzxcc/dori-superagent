import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnExec } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";
import type { Lane, LaneVerdict } from "../src/store-types.ts";
import { World, href } from "./fake.ts";

export const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await spawnExec("git", ["-C", cwd, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

export type PaneStatus = "working" | "idle" | "blocked" | "error" | "gone";

type FixtureOptions = {
  readonly merge?: boolean;
  readonly pane?: PaneStatus;
};

export const saveVerdict = (
  store: Store,
  o: {
    readonly tip: string;
    readonly base: string;
    readonly verdict: LaneVerdict;
    readonly at: number;
    readonly lane?: string;
    readonly patchId?: string;
    readonly contentId?: string;
  },
): void => {
  store.saveLaneReceipt({
    lane: o.lane ?? "scenario",
    verdict: o.verdict,
    base: o.base,
    tip: o.tip,
    ...(o.patchId === undefined ? {} : { patchId: o.patchId }),
    ...(o.contentId === undefined ? {} : { contentId: o.contentId }),
    brief: join(store.root, "brief.md"),
    reviewer: "test",
    at: o.at,
    summary: "",
  });
};

/**
 * A real repository with a READY lane: branch `lane/scenario` at the reviewed tip, a CLEAR receipt there, and (unless
 * `merge: false`) the PR landing as a merge commit on main, exactly the state `dori merge` leaves behind.
 */
export async function fixture(opts: FixtureOptions = {}) {
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
  const diff = await spawnExec("git", ["-C", repo, "diff", `${base}..${tip}`]);
  const stable = await spawnExec("git", ["patch-id", "--stable"], { stdin: diff.stdout });
  const verbatim = await spawnExec("git", ["patch-id", "--verbatim"], { stdin: diff.stdout });
  const patchId = stable.stdout.trim().split(/\s+/)[0];
  const contentId = verbatim.stdout.trim().split(/\s+/)[0];
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
  if (patchId !== undefined)
    saveVerdict(store, {
      tip,
      base,
      verdict: "CLEAR",
      at: 1,
      patchId,
      ...(contentId === undefined ? {} : { contentId }),
    });
  const w = new World();
  if (opts.pane !== "gone") w.addPane("w1:p9", opts.pane ?? "idle");
  const d = { ...w.deps(), store, exec: spawnExec, now: () => Date.now() };
  return { d, store, w, repo, root, worktree, base, tip, merge, patchId, contentId };
}
