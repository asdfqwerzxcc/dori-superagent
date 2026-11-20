import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { landBundle } from "../src/bundle-land.ts";
import { worktreeRoot } from "../src/lane-worktree.ts";
import { base, receipt, seededBundle, tipA, tipB, url } from "./bundle-setup.ts";

describe("bundle land", () => {
  test("dry run prints the ordered merge plan and touches no branch, push or PR", async () => {
    const { w, d, repo, repoPath } = await seededBundle();
    w.calls = [];
    const lines = await landBundle(d, "b1", { dryRun: true });
    const out = lines.join("\n");
    expect(out).toContain(`BUNDLE_LAND b1 (dry run) branch=bundle/b1 repo=acme/fork base=main@${base.slice(0, 12)}`);
    expect(out).toContain(`1. merge --no-ff lane/alpha @ ${tipA.slice(0, 12)}`);
    expect(out).toContain(`2. merge --no-ff lane/beta @ ${tipB.slice(0, 12)}`);
    expect(out).toContain("push fork bundle/b1");
    expect(out).toContain("LAND_DRY_RUN b1 members=2");
    expect(w.calls.some((c) => c.cmd === "gh")).toBe(false);
    expect(w.calls.some((c) => c.cmd === "git" && (c.argv.includes("worktree") || c.argv.includes("push")))).toBe(
      false,
    );
    expect(repo.heads?.[repoPath]).toBe(base);
    expect(d.store.bundle("b1")!.status).toBe("open");
  });

  test("merges members in order with --no-ff, pushes the fork branch and creates the PR from the template", async () => {
    const { w, d, repo, repoPath } = await seededBundle();
    const wt = join(worktreeRoot(d), "_bundles", "b1");
    repo.heads = { [repoPath]: base, [wt]: tipB };
    w.gh = (argv) => {
      if (argv[0] === "pr" && argv[1] === "view") return { code: 1, stdout: "no pull requests found for branch" };
      if (argv[0] === "pr" && argv[1] === "create") return { code: 0, stdout: `${url}\n` };
      return { code: 1, stdout: `unhandled gh ${argv.join(" ")}` };
    };
    const lines = await landBundle(d, "b1");
    expect(lines.at(-1)).toBe(`LANDED b1 branch=bundle/b1 head=${tipB.slice(0, 12)} pr=#42 ${url}`);

    const merges = w.calls.filter((c) => c.cmd === "git" && c.argv.includes("merge"));
    expect(merges.map((c) => c.argv.at(-1))).toEqual(["lane/alpha", "lane/beta"]);
    expect(merges.every((c) => c.argv.includes("--no-ff"))).toBe(true);
    const add = w.calls.find(
      (c) => c.cmd === "git" && c.argv.includes("worktree") && c.argv.includes("add") && c.argv.includes("bundle/b1"),
    );
    expect(add?.argv).toContain("bundle/b1");
    expect(add?.argv).toContain("main");
    const push = w.calls.find((c) => c.cmd === "git" && c.argv.includes("push"));
    expect(push?.argv).toContain("--force-with-lease");
    expect(push?.argv).toContain("refs/heads/bundle/b1:refs/heads/bundle/b1");
    const create = w.calls.find((c) => c.cmd === "gh" && c.argv[1] === "create");
    expect(create?.argv).toContain("--base");
    expect(create?.argv).toContain("main");
    expect(create?.argv).toContain("--head");
    expect(create?.argv).toContain("bundle/b1");

    const body = readFileSync(join(d.store.root, "state", "bundles", "b1.md"), "utf8");
    expect(body).toContain("## 무엇");
    expect(body).toContain("## 구성원");
    expect(body).toContain("Closes #12");
    expect(body).not.toContain("Closes #123");
    expect(body).toContain(`lane/alpha @ ${tipA.slice(0, 12)} - CLEAR, reviewer-alpha`);
    expect(body).toContain(`lane/beta @ ${tipB.slice(0, 12)} - CLEAR, reviewer-beta`);
    expect(d.store.bundle("b1")).toMatchObject({ status: "landed", pr: { number: 42, url } });
  });

  test("a merge conflict stops at that member, keeps the partial branch and pushes nothing", async () => {
    const { w, d, repo } = await seededBundle();
    repo.mergeFails = "CONFLICT (content): Merge conflict in docs/b.md";
    repo.mergeFailOn = "lane/beta";
    repo.conflictFiles = "docs/b.md";
    const failure: unknown = await landBundle(d, "b1").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("merge of lane/beta conflicted");
    expect((failure as Error).message).toContain("stopped after 1 of 2");
    expect((failure as Error).message).toContain("docs/b.md");
    expect(w.calls.some((c) => c.cmd === "git" && c.argv.includes("push"))).toBe(false);
    expect(w.calls.some((c) => c.cmd === "gh")).toBe(false);
    expect(d.store.bundle("b1")!.status).toBe("open");
  });

  test("land re-checks the recorded sha and refuses a lane that moved after add", async () => {
    const { d, repo } = await seededBundle();
    repo.refs = { ...(repo.refs ?? {}), "lane/beta": tipA };
    receipt(d, "beta", tipA);
    await expect(landBundle(d, "b1", { dryRun: true })).rejects.toThrow("moved since it was added");
  });
});
