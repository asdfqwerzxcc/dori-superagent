import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, startLane } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import { setup } from "./harness-setup.ts";
import { captureIo } from "./inbox-setup.ts";
import { base, gitCalls, repoGit, repoWorld } from "./lanes-setup.ts";

describe("lane worktree at start", () => {
  test("start creates, locks and asserts the worktree, and the pane opens in it", async () => {
    const { w, d, brief, repo } = repoWorld();
    const lane = await startLane(d, "own-tree", brief, { group: "w1" });
    const wt = join(d.store.root, "worktrees", "own-tree");

    expect(lane.worktree).toBe(wt);
    expect(lane.repo).toBe(repo);
    expect(lane.baseSha).toBe(base);
    const calls = gitCalls(w);
    expect(calls).toContain(`-C ${repo} worktree add -b lane/own-tree ${wt} ${base}`);
    expect(calls).toContain(`-C ${repo} worktree lock --reason dori lane own-tree ${wt}`);
    expect(calls).toContain(`-C ${repo} merge-base --is-ancestor ${base} lane/own-tree`);
    const tab = w.calls.find((c) => c.cmd === "herdr" && c.argv[0] === "tab" && c.argv[1] === "create")!;
    expect(tab.argv).toContain(wt);
  });

  test("start without a repository keeps the caller's cwd and records no worktree", async () => {
    const { w, d, brief } = setup();
    const lane = await startLane(d, "plain", brief, { group: "w1" });
    expect(lane.worktree).toBeUndefined();
    expect(lane.repo).toBeUndefined();
    const calls = gitCalls(w);
    expect(calls.some((c) => c.includes(" worktree "))).toBe(false);
    const tab = w.calls.find((c) => c.cmd === "herdr" && c.argv[0] === "tab" && c.argv[1] === "create")!;
    expect(tab.argv).toContain(lane.cwd);
  });

  test("a failed worktree add refuses the start with git's reason and leaves no pane or branch", async () => {
    const { w, d, lead, brief } = setup();
    const repo = join(d.store.root, "main");
    const wt = join(d.store.root, "worktrees", "no-tree");
    w.git = repoGit(repo, { addFails: `fatal: '${wt}' already exists\n` });
    const panes = w.panes.size;

    const failure: unknown = await startLane(d, "no-tree", brief, { group: "w1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Error).message).toContain("worktree_unavailable");
    expect((failure as Error).message).toContain("already exists");
    expect(w.panes.size).toBe(panes);
    expect(d.store.lane("no-tree")).toBeUndefined();
    expect(lead.received).toEqual([]);
    expect(gitCalls(w)).toContain(`-C ${repo} branch -D lane/no-tree`);
  });

  test("a repository whose HEAD cannot be read refuses the start instead of sharing the checkout", async () => {
    const { w, d, brief } = setup();
    const repo = join(d.store.root, "main");
    w.git = (argv) => {
      const args = argv[0] === "-C" ? argv.slice(2) : argv;
      if (args[0] === "rev-parse" && args.includes("--show-toplevel"))
        return { code: 0, stdout: `${repo}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--verify")) return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 1, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const panes = w.panes.size;
    const failure: unknown = await startLane(d, "empty-repo", brief, { group: "w1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Refusal);
    expect((failure as Error).message).toContain("cannot read HEAD");
    expect(w.panes.size).toBe(panes);
    expect(d.store.lane("empty-repo")).toBeUndefined();
  });

  test("a worktree root that cannot be created refuses the start loudly and writes nothing", async () => {
    const { w, d, brief, repo } = repoWorld();
    const blocked = join(d.store.root, "blocked-root");
    writeFileSync(blocked, "a file where the worktree root must be a directory");
    const panes = w.panes.size;
    process.env["DORI_WORKTREES_DIR"] = blocked;
    try {
      const failure: unknown = await startLane(d, "blocked-tree", brief, { group: "w1" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(Refusal);
      const message = (failure as Error).message;
      expect(message).toContain("cannot create a worktree for lane blocked-tree");
      expect(message).toContain(blocked);
      expect(message).toContain(`nothing was written to ${repo}`);
      expect(w.panes.size).toBe(panes);
      expect(d.store.lane("blocked-tree")).toBeUndefined();
    } finally {
      delete process.env["DORI_WORKTREES_DIR"];
    }
  });

  test("stale locks are named and left in place, and long paths off warns", async () => {
    const { w, d, brief } = setup();
    const repo = join(d.store.root, "main");
    const gitDir = join(repo, ".git");
    mkdirSync(join(gitDir, "worktrees", "old"), { recursive: true });
    const indexLock = join(gitDir, "index.lock");
    const headLock = join(gitDir, "worktrees", "old", "HEAD.lock");
    writeFileSync(indexLock, "");
    writeFileSync(headLock, "");
    w.git = repoGit(repo, { longpaths: "" });

    const { code, out } = await captureIo(async () => {
      await startLane(d, "warned", brief, { group: "w1" });
      return 0;
    });
    expect(code).toBe(0);
    expect(out).toContain(`stale git lock ${indexLock}`);
    expect(out).toContain(`stale git lock ${headLock}`);
    expect(out).toContain("core.longpaths is not true");
    expect(existsSync(indexLock)).toBe(true);
    expect(existsSync(headLock)).toBe(true);
  });

  test("a dropped lane key can be started again", async () => {
    const { d, brief } = setup();
    await startLane(d, "again", brief, { group: "w1" });
    await done(d, "again", { drop: "restart" });
    expect(d.store.lane("again")!.status).toBe("dropped");
    const again = await startLane(d, "again", brief, { group: "w1" });
    expect(again.status).toBe("working");
  });

  test("a lost lane key is refused until it is dropped", async () => {
    const { d, brief } = setup();
    await startLane(d, "lost-key", brief, { group: "w1" });
    const lane = d.store.lane("lost-key")!;
    lane.status = "lost";
    d.store.saveLane(lane);

    await expect(startLane(d, "lost-key", brief, { group: "w1" })).rejects.toThrow("is lost");
    expect(await done(d, "lost-key", { drop: "lost" })).toBe("dropped: lost");
    const again = await startLane(d, "lost-key", brief, { group: "w1" });
    expect(again.status).toBe("working");
  });

  test("a failed add leaves a branch it did not create in place", async () => {
    const { w, d, brief } = setup();
    const repo = join(d.store.root, "main");
    const wt = join(d.store.root, "worktrees", "kept");
    w.git = repoGit(repo, { addFails: `fatal: '${wt}' already exists\n`, branchExists: true });

    const failure: unknown = await startLane(d, "kept", brief, { group: "w1" }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Refusal);
    expect(gitCalls(w)).not.toContain(`-C ${repo} branch -D lane/kept`);
  });

  test("DORI_WORKTREES_DIR overrides the worktree root", async () => {
    const { w, d, brief, repo } = repoWorld();
    const elsewhere = join(d.store.root, "elsewhere");
    const saved = process.env["DORI_WORKTREES_DIR"];
    process.env["DORI_WORKTREES_DIR"] = elsewhere;
    try {
      const lane = await startLane(d, "env-root", brief, { group: "w1" });
      const wt = join(elsewhere, "env-root");
      expect(lane.worktree).toBe(wt);
      expect(gitCalls(w)).toContain(`-C ${repo} worktree add -b lane/env-root ${wt} ${base}`);
    } finally {
      if (saved === undefined) delete process.env["DORI_WORKTREES_DIR"];
      else process.env["DORI_WORKTREES_DIR"] = saved;
    }
  });
});
