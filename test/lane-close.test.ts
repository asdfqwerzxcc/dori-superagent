import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";
import type { Lane } from "../src/store-types.ts";
import { World, href } from "./fake.ts";

setDefaultTimeout(30_000);

const git = async (...args: string[]): Promise<string> => {
  const r = await spawnExec("git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const gitCode = async (...args: string[]): Promise<number> => (await spawnExec("git", args)).code;

type Fixture = Awaited<ReturnType<typeof fixture>>;
type FixtureOptions = { readonly commit?: boolean; readonly branch?: boolean };

/** A real repo with a READY lane whose recorded tip is `base` (on main) and whose branch may hold newer commits. */
async function fixture(opts: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "dori-lane-close-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  await git("init", "-b", "main", repo);
  await git("-C", repo, "config", "user.email", "test@example.test");
  await git("-C", repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git("-C", repo, "add", "--", "base.txt");
  await git("-C", repo, "commit", "-m", "base");
  const base = await git("-C", repo, "rev-parse", "HEAD");
  const worktree = join(root, "lane-tree");
  await git("-C", repo, "worktree", "add", "-b", "lane/scenario", worktree, base);
  if (opts.commit !== false) await git("-C", worktree, "commit", "--allow-empty", "-m", "after the last review");
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
    tipSha: base,
    status: "ready",
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    final: { text: "final", evidence: ["https://example.test/pull/1"], at: 1 },
    log: [{ at: 1, kind: "ready", text: "final" }],
  };
  const store = new Store(home);
  store.saveLane(lane);
  rmSync(worktree, { recursive: true, force: true });
  if (opts.branch === false) {
    await git("-C", repo, "worktree", "prune");
    await git("-C", repo, "branch", "-D", "lane/scenario");
  }
  const d = { ...new World().deps(), store, exec: spawnExec, now: () => Date.now() };
  return { d, store, repo, root, worktree, base, lane };
}

const refusalOf = async (d: Fixture["d"]): Promise<Error> => {
  const failure: unknown = await done(d, "scenario").then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(failure).toBeInstanceOf(Refusal);
  return failure as Error;
};

describe("done without a worktree", () => {
  test("a surviving branch with post-review commits refuses even when the recorded tip is on main", async () => {
    const { d, store, repo, base } = await fixture();
    const branchTip = await git("-C", repo, "rev-parse", "lane/scenario");
    expect(branchTip).not.toBe(base);
    expect(await gitCode("-C", repo, "merge-base", "--is-ancestor", branchTip, "HEAD")).toBe(1);

    const failure = await refusalOf(d);
    expect(failure.message).toContain("nothing proves the lane landed");
    expect(failure.message).toContain("dori done --drop scenario --reason");
    expect(store.lane("scenario")!.status).toBe("ready");
    expect(await gitCode("-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/lane/scenario")).toBe(0);
  });

  test("a landed branch closes, deletes the branch and clears the worktree registration", async () => {
    const { d, store, repo, root } = await fixture();
    await git("-C", repo, "merge", "--ff-only", "lane/scenario");

    const note = await done(d, "scenario");
    expect(note).toContain("is already on main");
    expect(store.lane("scenario")!.status).toBe("done");
    expect(await gitCode("-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/lane/scenario")).not.toBe(0);
    expect(await git("-C", repo, "worktree", "list", "--porcelain")).not.toContain("lane/scenario");
    await git("-C", repo, "worktree", "add", "-b", "lane/scenario", join(root, "retry"), "HEAD");
  });

  test("a branch already deleted by the landed close needs its CLEAR receipt as the proof", async () => {
    const { d, store, base } = await fixture({ branch: false });
    store.saveLaneReceipt({
      lane: "scenario",
      verdict: "CLEAR",
      base,
      tip: base,
      brief: join(store.root, "brief.md"),
      reviewer: "test",
      at: 1,
      summary: "reviewed before the merge",
    });

    const note = await done(d, "scenario");
    expect(note).toContain("is already on main");
    expect(store.lane("scenario")!.status).toBe("done");
  });

  test("a deleted branch without a receipt refuses and names the --drop exit", async () => {
    const { d, store } = await fixture({ branch: false });
    const failure = await refusalOf(d);
    expect(failure.message).toContain("CLEAR receipt");
    expect(failure.message).toContain("dori done --drop scenario --reason");
    expect(store.lane("scenario")!.status).toBe("ready");
  });
});
