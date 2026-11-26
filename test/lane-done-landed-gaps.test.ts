import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { done } from "../src/lanes.ts";
import { fixture, git, saveVerdict } from "./lane-done-landed-setup.ts";

setDefaultTimeout(30_000);

describe("done after a PR landing: refusals", () => {
  test("a BLOCK on the merge parent refuses instead of closing", async () => {
    const { d, store, worktree, base, tip } = await fixture({ pane: "gone" });
    saveVerdict(store, { tip, base, verdict: "BLOCK", at: 2 });
    await git(worktree, "rebase", "main");

    await expect(done(d, "scenario")).rejects.toThrow("is BLOCK");
    expect(store.lane("scenario")!.status).toBe("ready");
  });

  test("a CLEAR receipt for another lane does not prove this lane landed", async () => {
    const { d, store, worktree, base, tip } = await fixture({ pane: "gone" });
    rmSync(store.receipts.laneReceiptPath("scenario", tip));
    saveVerdict(store, { lane: "other", tip, base, verdict: "CLEAR", at: 2 });
    await git(worktree, "rebase", "main");

    await expect(done(d, "scenario")).rejects.toThrow("no review receipt");
    expect(store.lane("scenario")!.status).toBe("ready");
  });
});

describe("done after a PR landing: gone worktree proof", () => {
  test("a surviving branch main contains closes even when its receipt is BLOCK", async () => {
    const { d, store, repo, worktree, base, tip } = await fixture({ pane: "gone" });
    saveVerdict(store, { tip, base, verdict: "BLOCK", at: 2 });
    rmSync(worktree, { recursive: true, force: true });
    await git(repo, "worktree", "prune");

    const note = await done(d, "scenario");
    expect(note).toContain("is already on main");
    expect(store.lane("scenario")!.status).toBe("done");
    expect(await git(repo, "branch", "--list", "lane/scenario")).toBe("");
  });
});

describe("done after a PR landing: pane states", () => {
  test("a landed lane closes while its pane is blocked", async () => {
    const { d, store, w, tip } = await fixture({ pane: "blocked" });

    const note = await done(d, "scenario");
    expect(note).toContain("pane was blocked on a landed lane");
    expect(note).toContain(`lane/scenario@${tip.slice(0, 12)} is already on main`);
    expect(store.lane("scenario")!.status).toBe("done");
    expect(w.panes.has("w1:p9")).toBe(false);
  });

  test("a landed lane closes while its pane is error", async () => {
    const { d, store, w, tip } = await fixture({ pane: "idle" });
    const rt = {
      probe: async () => ({ status: "error" as const, shellInFront: false }),
      close: async () => {
        w.panes.delete("w1:p9");
      },
    };
    const withError = { ...d, runtimes: { for: () => rt } } as unknown as typeof d;

    const note = await done(withError, "scenario");
    expect(note).toContain("pane was error on a landed lane");
    expect(note).toContain(`lane/scenario@${tip.slice(0, 12)} is already on main`);
    expect(store.lane("scenario")!.status).toBe("done");
    expect(w.panes.has("w1:p9")).toBe(false);
  });

  test("a squash-landed lane closes while its pane works", async () => {
    const { d, store, repo, w } = await fixture({ merge: false, pane: "working" });
    await git(repo, "merge", "--squash", "lane/scenario");
    await git(repo, "commit", "-m", "squash lane/scenario");

    const note = await done(d, "scenario");
    expect(note).toContain("pane was working on a landed lane");
    expect(note).toContain("matches main by content (squash)");
    expect(store.lane("scenario")!.status).toBe("done");
    expect(w.panes.has("w1:p9")).toBe(false);
  });

  test("a landed lane with a gone worktree closes while its pane works", async () => {
    const { d, store, repo, worktree, w, tip } = await fixture({ pane: "working" });
    rmSync(worktree, { recursive: true, force: true });
    await git(repo, "worktree", "prune");
    await git(repo, "branch", "-D", "lane/scenario");

    const note = await done(d, "scenario");
    expect(note).toContain("pane was working");
    expect(note).toContain(`CLEAR receipt lane_scenario@${tip}`);
    expect(store.lane("scenario")!.status).toBe("done");
    expect(w.panes.has("w1:p9")).toBe(false);
  });
});
