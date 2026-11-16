import type { World } from "./fake.ts";

export type Repo = {
  head: string;
  /** HEAD inside a lane worktree; defaults to `head`. */
  worktreeHead?: string;
  mergeBase?: string;
  diff?: string;
  dirty?: string;
  /** false makes `merge-base --is-ancestor` say the branch does not descend. */
  ancestor?: boolean;
  worktreeAdd?: { code: number; stdout: string; stderr?: string };
  /** true makes `rev-parse --verify` report the lane branch as already present. */
  branchExists?: boolean;
  longpaths?: string;
  mergeFails?: string;
};

const defaultDiff = "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n";

export function fakeGit(w: World, repo: Repo): void {
  w.git = (argv) => {
    const cwd = argv[0] === "-C" ? argv[1] : undefined;
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    const [cmd, sub] = args;
    if (cmd === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n" };
    if (cmd === "rev-parse" && args.includes("--verify"))
      return repo.branchExists === true ? { code: 0, stdout: `${repo.head}\n` } : { code: 1, stdout: "", stderr: "" };
    if (cmd === "rev-parse")
      return { code: 0, stdout: `${cwd === "/repo" ? repo.head : (repo.worktreeHead ?? repo.head)}\n` };
    if (cmd === "config") return { code: 0, stdout: `${repo.longpaths ?? "true"}\n` };
    if (cmd === "status") return { code: 0, stdout: repo.dirty ?? "" };
    if (cmd === "worktree" && sub === "add") return repo.worktreeAdd ?? { code: 0, stdout: "", stderr: "" };
    if (cmd === "worktree") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "merge-base" && args.includes("--is-ancestor"))
      return repo.ancestor === false
        ? { code: 1, stdout: "", stderr: "not an ancestor" }
        : { code: 0, stdout: "", stderr: "" };
    if (cmd === "merge-base") return { code: 0, stdout: `${repo.mergeBase ?? repo.head}\n` };
    if (args.includes("diff")) return { code: 0, stdout: repo.diff ?? defaultDiff };
    if (cmd === "merge")
      return repo.mergeFails === undefined
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: repo.mergeFails };
    if (cmd === "branch") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "rebase") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unhandled git ${argv.join(" ")}` };
  };
}
