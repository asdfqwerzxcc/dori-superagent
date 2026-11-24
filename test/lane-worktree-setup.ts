import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { World } from "./fake.ts";
import { fakeGit, type Repo } from "./fake-git.ts";
import { setup } from "./harness-setup.ts";

export const base = "a".repeat(40);
export const tip = "b".repeat(40);
export const diff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

export const wtPath = (d: Deps, key: string): string => join(d.store.root, "worktrees", key);

export const gitCalls = (w: World): string[] => w.calls.filter((c) => c.cmd === "git").map((c) => c.argv.join(" "));

/** A harness world whose git answers come from `fakeGit`, laid over the base repo the lane tests share. */
export function laneWorld(repo: Partial<Repo> = {}) {
  const { w, d, brief } = setup();
  const full: Repo = { head: base, worktreeHead: base, mergeBase: base, diff, ...repo };
  fakeGit(w, full);
  return { w, d, brief, repo: full };
}
