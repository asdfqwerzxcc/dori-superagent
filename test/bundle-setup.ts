import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMembers, openBundle } from "../src/bundles.ts";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

export const base = "a".repeat(40);
export const tipA = "b".repeat(40);
export const tipB = "c".repeat(40);
export const tipC = "d".repeat(40);
export const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";
export const url = "https://github.com/acme/fork/pull/42";

export function receipt(d: Deps, key: string, tip: string, verdict: "CLEAR" | "BLOCK" = "CLEAR", reviewer = "omo") {
  d.store.saveLaneReceipt({
    lane: key,
    verdict,
    base,
    tip,
    brief: join(d.store.root, "brief.md"),
    reviewer,
    at: d.now(),
    summary: "",
  });
}

export function templateRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dori-bundle-repo-"));
  mkdirSync(join(dir, ".github"), { recursive: true });
  writeFileSync(
    join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"),
    "## 무엇\n\nfill\n\n## 왜\n\n<!-- 예: Closes #123 -->\nfill\n",
  );
  return dir;
}

/** Two lanes from one checkout, both CLEAR, already members of open bundle `b1` targeting the fork remote. */
export async function seededBundle() {
  const { w, d } = setup();
  const repo: Repo = { head: base, mergeBase: base, diff };
  fakeGit(w, repo);
  const repoPath = templateRepo();
  for (const [key, sha] of [
    ["alpha", tipA],
    ["beta", tipB],
  ] as const) {
    const lane = await startLane(d, key, join(d.store.root, "brief.md"), { group: "w1" });
    d.store.saveLane({ ...lane, repo: repoPath });
    repo.refs = { ...(repo.refs ?? {}), [`lane/${key}`]: sha };
    receipt(d, key, sha, "CLEAR", `reviewer-${key}`);
  }
  repo.remotes = { fork: "https://github.com/acme/fork.git" };
  repo.heads = { [repoPath]: base };
  openBundle(d, "b1", { title: "Bundle login fixes", repo: "acme/fork", issue: 12 });
  await addMembers(d, "b1", ["alpha", "beta"]);
  return { w, d, repo, repoPath };
}
