import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done } from "../src/lanes.ts";
import { captureIo } from "./inbox-setup.ts";
import { fixture, git, saveVerdict } from "./lane-done-landed-setup.ts";

setDefaultTimeout(30_000);

describe("done after a PR landing", () => {
  test("a lane rebased onto the merge commit closes by the receipt on its parent", async () => {
    const { d, store, worktree, repo, tip } = await fixture({ merge: false, pane: "gone" });
    // The observed dashboard-kpi-pattern shape: main moved before the PR landed, then `git rebase main` moved the
    // already-merged branch onto the merge commit, where the lane diff no longer matches the reviewed patch.
    writeFileSync(join(repo, "before-merge.txt"), "main moved\n");
    await git(repo, "add", "--", "before-merge.txt");
    await git(repo, "commit", "-m", "main work before the merge");
    await git(repo, "merge", "--no-ff", "-m", "Merge pull request #1 from lane/scenario", "lane/scenario");
    const merge = await git(repo, "rev-parse", "HEAD");
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

  test("a same-patch BLOCK on main still refuses a rebased-after-merge lane", async () => {
    const { d, store, worktree, repo, base, tip, patchId, contentId } = await fixture({ merge: false, pane: "gone" });
    if (patchId === undefined) throw new Error("fixture has no patch id");
    // main moves before the PR lands, so the merge commit's own diff is not the lane's patch and the tip lookup is silent.
    writeFileSync(join(repo, "before-merge.txt"), "main moved\n");
    await git(repo, "add", "--", "before-merge.txt");
    await git(repo, "commit", "-m", "main work before the merge");
    const tree = await git(repo, "rev-parse", `${tip}^{tree}`);
    const blocked = await git(repo, "commit-tree", tree, "-p", base, "-m", "the same patch, blocked later");
    saveVerdict(store, {
      tip: blocked,
      base,
      verdict: "BLOCK",
      at: 2,
      patchId,
      ...(contentId === undefined ? {} : { contentId }),
    });
    await git(repo, "merge", "--no-ff", "-m", "Merge pull request #1 from lane/scenario", "lane/scenario");
    await git(worktree, "rebase", "main");

    await expect(done(d, "scenario")).rejects.toThrow("is BLOCK");
    expect(store.lane("scenario")!.status).toBe("ready");
  });

  test("a fallback receipt never publishes a follow-up commit the lane branch holds", async () => {
    const { d, store, worktree, repo } = await fixture({ merge: false, pane: "gone" });
    writeFileSync(join(repo, "before-merge.txt"), "main moved\n");
    await git(repo, "add", "--", "before-merge.txt");
    await git(repo, "commit", "-m", "main work before the merge");
    await git(repo, "merge", "--no-ff", "-m", "Merge pull request #1 from lane/scenario", "lane/scenario");
    const merge = await git(repo, "rev-parse", "HEAD");
    writeFileSync(join(worktree, "follow-up.txt"), "follow-up\n");
    await git(worktree, "add", "--", "follow-up.txt");
    await git(worktree, "commit", "-m", "follow-up main never got");
    await git(worktree, "checkout", "-q", "--detach", merge);

    await expect(done(d, "scenario")).rejects.toThrow("does not publish commits");
    expect(store.lane("scenario")!.status).toBe("ready");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(merge);
    expect(await git(repo, "rev-parse", "lane/scenario")).not.toBe(merge);
  });
});
