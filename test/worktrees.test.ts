import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../src/cli-up.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { Store } from "../src/store.ts";
import type { Lane, LaneStatus } from "../src/store-types.ts";
import { listWorktrees, pruneWorktrees } from "../src/worktrees.ts";
import { World, href } from "./fake.ts";
import { captureIo } from "./inbox-setup.ts";

setDefaultTimeout(30_000);

const git = async (...args: string[]): Promise<string> => {
  const r = await spawnExec("git", args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dori-worktrees-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const wtRoot = join(home, "trees");
  mkdirSync(repo);
  mkdirSync(home);
  mkdirSync(wtRoot, { recursive: true });
  await git("init", "-b", "main", repo);
  await git("-C", repo, "config", "user.email", "test@example.test");
  await git("-C", repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "base.txt"), "base\n");
  await git("-C", repo, "add", "--", "base.txt");
  await git("-C", repo, "commit", "-m", "base");
  const base = await git("-C", repo, "rev-parse", "HEAD");
  const saved = process.env["DORI_WORKTREES_DIR"];
  process.env["DORI_WORKTREES_DIR"] = wtRoot;
  const store = new Store(home);
  const d = { ...new World().deps(), store, exec: spawnExec, now: () => Date.now() };
  let pane = 1;
  const lane = (key: string, state: LaneStatus): Lane => ({
    key,
    sessionRef: href(`w1:p${pane++}`),
    paneId: "",
    tabId: "",
    brief: join(home, "briefs", `${key}.md`),
    cwd: repo,
    worktree: join(wtRoot, key),
    repo,
    baseSha: base,
    tipSha: base,
    status: state,
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    log: [],
  });
  const tree = async (key: string): Promise<void> => {
    await git("-C", repo, "worktree", "add", "-q", "-b", `lane/${key}`, join(wtRoot, key), base);
  };
  const cleanup = (): void => {
    if (saved === undefined) delete process.env["DORI_WORKTREES_DIR"];
    else process.env["DORI_WORKTREES_DIR"] = saved;
    rmSync(root, { recursive: true, force: true });
  };
  return { root, repo, home, wtRoot, store, d, base, lane, tree, cleanup };
}

const lineFor = (out: string, key: string): string => out.split("\n").find((l) => l.startsWith(`TREE ${key} `))!;

describe("dori worktrees", () => {
  test("list names every tree with its lane status and orphan reason", async () => {
    const f: Fixture = await fixture();
    try {
      for (const key of ["live", "lost", "done", "orphan", "dirty"]) await f.tree(key);
      f.store.saveLane(f.lane("live", "working"));
      f.store.saveLane(f.lane("lost", "lost"));
      f.store.saveLane(f.lane("done", "done"));
      f.store.saveLane(f.lane("dirty", "done"));
      writeFileSync(join(f.wtRoot, "dirty", "dirty.txt"), "dirty\n");
      writeFileSync(join(f.repo, ".git", "index.lock"), "");

      const { out } = await captureIo(async () => {
        await listWorktrees(f.d);
        return 0;
      });
      expect(lineFor(out, "live")).toContain("status=working");
      expect(lineFor(out, "live")).not.toContain("orphan:");
      expect(lineFor(out, "lost")).toContain("orphan: lane lost");
      expect(lineFor(out, "done")).toContain("orphan: lane done");
      expect(lineFor(out, "orphan")).toContain("status=no lane");
      expect(lineFor(out, "orphan")).toContain("orphan: no lane record");
      expect(lineFor(out, "dirty")).toContain("dirty=1");
      expect(out).toContain(`LOCK ${join(f.repo, ".git", "index.lock")}`);
      expect(out).toContain("WORKTREES 4 orphan");
    } finally {
      f.cleanup();
    }
  });

  test("prune removes clean orphans and their branches, and leaves live and dirty trees", async () => {
    const f: Fixture = await fixture();
    try {
      for (const key of ["orphan", "lost", "done", "live", "dirty"]) await f.tree(key);
      f.store.saveLane(f.lane("lost", "lost"));
      f.store.saveLane(f.lane("done", "done"));
      f.store.saveLane(f.lane("live", "working"));
      f.store.saveLane(f.lane("dirty", "done"));
      writeFileSync(join(f.wtRoot, "dirty", "dirty.txt"), "dirty\n");

      const { out } = await captureIo(async () => {
        await pruneWorktrees(f.d);
        return 0;
      });
      expect(out).toContain("REMOVED orphan");
      expect(out).toContain("DELETED lane/orphan");
      expect(out).toContain("REMOVED lost");
      expect(out).toContain("DELETED lane/lost");
      expect(out).toContain("REMOVED done");
      expect(out).toContain("DIRTY dirty");
      expect(out).toContain("WORKTREES 3 pruned");
      expect(existsSync(join(f.wtRoot, "orphan"))).toBe(false);
      expect(existsSync(join(f.wtRoot, "lost"))).toBe(false);
      expect(existsSync(join(f.wtRoot, "done"))).toBe(false);
      expect(existsSync(join(f.wtRoot, "live"))).toBe(true);
      expect(existsSync(join(f.wtRoot, "dirty"))).toBe(true);
      expect(await git("-C", f.repo, "branch", "--list", "lane/orphan")).toBe("");
      expect(await git("-C", f.repo, "branch", "--list", "lane/live")).toContain("lane/live");
      expect(await git("-C", f.repo, "rev-parse", "HEAD")).toBe(f.base);
    } finally {
      f.cleanup();
    }
  });

  test("a stale HEAD lock is named and the tree is left in place", async () => {
    const f: Fixture = await fixture();
    try {
      await f.tree("locked");
      f.store.saveLane(f.lane("locked", "done"));
      const ids = readdirSync(join(f.repo, ".git", "worktrees"));
      const id = ids.find((name) =>
        readFileSync(join(f.repo, ".git", "worktrees", name, "gitdir"), "utf8")
          .trim()
          .replaceAll("\\", "/")
          .includes("/locked/.git"),
      );
      expect(id).toBeDefined();
      const lock = join(f.repo, ".git", "worktrees", id!, "HEAD.lock");
      writeFileSync(lock, "");

      const { out } = await captureIo(async () => {
        await pruneWorktrees(f.d);
        return 0;
      });
      expect(out).toContain("LOCKED locked");
      expect(out).toContain(lock);
      expect(existsSync(join(f.wtRoot, "locked"))).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  test("a dropped lane whose tree is already gone is not an orphan", async () => {
    const f: Fixture = await fixture();
    try {
      await f.tree("dropped");
      f.store.saveLane(f.lane("dropped", "dropped"));
      await git("-C", f.repo, "worktree", "remove", join(f.wtRoot, "dropped"));

      const listed = await captureIo(async () => {
        await listWorktrees(f.d);
        return 0;
      });
      expect(listed.out).not.toContain("TREE dropped");
      expect(listed.out).toContain("WORKTREES 0 orphan");
      const st = await captureIo(async () => {
        await status(f.d);
        return 0;
      });
      expect(st.out).not.toContain("WORKTREES");
    } finally {
      f.cleanup();
    }
  });

  test("status prints a WORKTREES orphan line only while one exists", async () => {
    const f: Fixture = await fixture();
    try {
      await f.tree("orphan");
      const before = await captureIo(async () => {
        await status(f.d);
        return 0;
      });
      expect(before.out).toContain("WORKTREES 1 orphan");
      await captureIo(async () => {
        await pruneWorktrees(f.d);
        return 0;
      });
      const after = await captureIo(async () => {
        await status(f.d);
        return 0;
      });
      expect(after.out).not.toContain("WORKTREES");
    } finally {
      f.cleanup();
    }
  });
});
