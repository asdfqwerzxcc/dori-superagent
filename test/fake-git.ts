import { createHash } from "node:crypto";
import type { World } from "./fake.ts";

export type Repo = {
  head: string;
  /** HEAD inside a lane worktree; defaults to `head`. */
  worktreeHead?: string;
  /** HEAD per checkout path, overriding `worktreeHead` (one lane worktree per key). */
  heads?: Record<string, string>;
  /** Branch refs answered by `rev-parse --verify refs/heads/<branch>`. */
  refs?: Record<string, string>;
  /** Answers for `remote get-url <name>`; a missing name fails like git. */
  remotes?: Record<string, string>;
  mergeBase?: string;
  diff?: string;
  /** Answer for `git patch-id`; absent hashes the stdin diff (or returns a stable id when there is none). */
  patchId?: string;
  /** Output of `diff --quiet <branch> HEAD`; empty means the same tree (a squash merge). Defaults to `diff`. */
  contentDiff?: string;
  /** Makes `diff --quiet <branch> HEAD` fail like a git error (exit 2) with this stderr, instead of comparing trees. */
  diffError?: string;
  dirty?: string;
  /** false makes `merge-base --is-ancestor` say the branch does not descend. */
  ancestor?: boolean;
  worktreeAdd?: { code: number; stdout: string; stderr?: string };
  /** true makes `rev-parse --verify` report the lane branch as already present. */
  branchExists?: boolean;
  longpaths?: string;
  mergeFails?: string;
  /** Only fail `merge` when its arguments name this branch; the failure text is `mergeFails`. */
  mergeFailOn?: string;
  /** `diff --name-only --diff-filter=U` output after a conflicted merge. */
  conflictFiles?: string;
  pushFails?: string;
  /** Only fail `git push --delete` with this stderr; the branch push still succeeds. */
  deleteFails?: string;
};

const defaultDiff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

export const fakePatchId = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 40);

export function fakeGit(w: World, repo: Repo): void {
  w.git = (argv, stdin) => {
    const cwd = argv[0] === "-C" ? argv[1] : undefined;
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    const [cmd, sub] = args;
    if (cmd === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n" };
    if (cmd === "rev-parse" && args.includes("--verify")) {
      const ref = [...args].reverse().find((a) => !a.startsWith("--"));
      if (ref?.startsWith("refs/heads/")) {
        const sha = repo.refs?.[ref.slice("refs/heads/".length)];
        return sha === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `${sha}\n` };
      }
      return repo.branchExists === true ? { code: 0, stdout: `${repo.head}\n` } : { code: 1, stdout: "", stderr: "" };
    }
    if (cmd === "rev-parse") {
      const sha =
        (cwd !== undefined ? repo.heads?.[cwd] : undefined) ??
        (cwd === "/repo" ? repo.head : (repo.worktreeHead ?? repo.head));
      return { code: 0, stdout: `${sha}\n` };
    }
    if (cmd === "remote" && sub === "get-url") {
      const url = repo.remotes?.[args[2] ?? ""];
      return url === undefined
        ? { code: 2, stdout: "", stderr: `No such remote '${args[2] ?? ""}'\n` }
        : { code: 0, stdout: `${url}\n` };
    }
    if (cmd === "push") {
      if (args.includes("--delete"))
        return repo.deleteFails === undefined
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 1, stdout: "", stderr: repo.deleteFails };
      return repo.pushFails === undefined
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: repo.pushFails };
    }
    if (cmd === "config") return { code: 0, stdout: `${repo.longpaths ?? "true"}\n` };
    if (cmd === "status") return { code: 0, stdout: repo.dirty ?? "" };
    if (cmd === "worktree" && sub === "add") return repo.worktreeAdd ?? { code: 0, stdout: "", stderr: "" };
    if (cmd === "worktree") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "merge-base" && args.includes("--is-ancestor"))
      return repo.ancestor === false
        ? { code: 1, stdout: "", stderr: "not an ancestor" }
        : { code: 0, stdout: "", stderr: "" };
    if (cmd === "merge-base") return { code: 0, stdout: `${repo.mergeBase ?? repo.head}\n` };
    if (cmd === "patch-id") {
      const id = repo.patchId ?? (stdin === undefined || stdin.trim() === "" ? "0".repeat(40) : fakePatchId(stdin));
      return { code: 0, stdout: `${id} ${"0".repeat(40)}\n` };
    }
    if (args.includes("diff") && args.includes("--diff-filter=U")) return { code: 0, stdout: repo.conflictFiles ?? "" };
    if (args.includes("diff")) {
      if (args.includes("--quiet") && repo.diffError !== undefined)
        return { code: 2, stdout: "", stderr: `${repo.diffError}\n` };
      const out = (args.includes("--quiet") ? repo.contentDiff : undefined) ?? repo.diff ?? defaultDiff;
      // `git diff --quiet` signals differences through its exit code, not its output.
      if (args.includes("--quiet")) return { code: out.trim() === "" ? 0 : 1, stdout: "", stderr: "" };
      return { code: 0, stdout: out };
    }
    if (cmd === "merge") {
      const fails =
        repo.mergeFails !== undefined && (repo.mergeFailOn === undefined || args.includes(repo.mergeFailOn));
      return fails
        ? { code: 1, stdout: "", stderr: repo.mergeFails ?? "merge conflict" }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "branch") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "rebase") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unhandled git ${argv.join(" ")}` };
  };
}
