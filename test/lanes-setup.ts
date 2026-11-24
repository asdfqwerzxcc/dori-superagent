import { join } from "node:path";
import type { World } from "./fake.ts";
import { setup } from "./harness-setup.ts";

export const base = "a".repeat(40);
export const clearGroupEnv = { HERDR_PANE_ID: undefined, HERDR_WORKSPACE_ID: undefined, HC_TERMINAL_ID: undefined };

export const gitCalls = (w: World): string[] => w.calls.filter((c) => c.cmd === "git").map((c) => c.argv.join(" "));

/** Runs `run` with the given environment variables set, restoring each one afterwards. */
export async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

export type RepoGitOptions = { addFails?: string; branchExists?: boolean; longpaths?: string };

/** A git stub for the worktree-at-start tests: one repo toplevel, a fixed HEAD, and worktree add answers. */
export function repoGit(repo: string, opts: RepoGitOptions = {}) {
  return (argv: readonly string[]) => {
    const args = argv[0] === "-C" ? argv.slice(2) : argv;
    const [cmd, sub] = args;
    if (cmd === "rev-parse" && args.includes("--show-toplevel")) return { code: 0, stdout: `${repo}\n` };
    if (cmd === "rev-parse" && args.includes("--verify"))
      return opts.branchExists === true ? { code: 0, stdout: `${base}\n` } : { code: 1, stdout: "", stderr: "" };
    if (cmd === "rev-parse") return { code: 0, stdout: `${base}\n` };
    if (cmd === "config") return { code: 0, stdout: `${opts.longpaths ?? "true"}\n` };
    if (cmd === "worktree" && sub === "add")
      return opts.addFails === undefined
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 128, stdout: "", stderr: opts.addFails };
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** A world whose git answers come from `repoGit`, with the repo path the stub reports. */
export function repoWorld(opts: RepoGitOptions = {}) {
  const { w, d, lead, brief } = setup();
  const repo = join(d.store.root, "main");
  w.git = repoGit(repo, opts);
  return { w, d, lead, brief, repo };
}
