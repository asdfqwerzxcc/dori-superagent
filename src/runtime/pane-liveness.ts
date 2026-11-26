// A pane can outlive the TUI that ran in it, and the runtime keeps answering with the last status word it saw: on
// 2026-11-26 a lane killed every bun.exe on the host and herdr still reported the lead's pane as `working` for 90
// minutes. The pane's own process tree is the proof: a pane rooted in a shell with no child at all has nothing in
// front of it, so no agent can be alive there. Anything the tree cannot prove is doubt, and doubt never types.

import { listProcessTree, normalizeExe, type ProcNode } from "../process-tree.ts";
import { SHELLS } from "./foreground.ts";

/** The OS process snapshot the check reads. `undefined` is an unreadable snapshot: doubt, never death. */
export type PaneTree = () => Promise<readonly ProcNode[] | undefined>;

/**
 * The tree's verdict on one pane. `alive`: the root process has a child, so something runs in it. `exited`: the root
 * is a shell with no child, so nothing can be. `doubt`: a missing root pid, an unreadable snapshot, or a root that is
 * not a shell — never acted on as either.
 */
export type PaneLiveness = "alive" | "exited" | "doubt";

// As a pane root, cmd.exe is the prompt the pane opened with, not the `cmd /c` child of an agent that SHELLS guards
// against; every other shell a pane opens on is already in SHELLS.
const PANE_SHELLS: ReadonlySet<string> = new Set([...SHELLS, "cmd"]);

/**
 * D2: one snapshot of the pane's own process tree, rooted at `process_info.shell_pid`. Only a childless shell proves
 * death; every other shape, including a snapshot that cannot be read, is doubt, because a wrong `exited` revives a
 * lead that is still talking.
 */
export async function paneLiveness(tree: PaneTree, rootPid: number | undefined): Promise<PaneLiveness> {
  if (rootPid === undefined) return "doubt";
  let nodes: readonly ProcNode[] | undefined;
  try {
    nodes = await tree();
  } catch {
    return "doubt";
  }
  if (nodes === undefined) return "doubt";
  const root = nodes.find((node) => node.pid === rootPid);
  if (root === undefined) return "doubt";
  if (!PANE_SHELLS.has(normalizeExe(root.exe))) return "alive";
  return nodes.some((node) => node.parent === rootPid) ? "alive" : "exited";
}

// The prompt shapes a pane's shell leaves as its last line, each ending at the prompt character with nothing after it and
// no second `>` inside: a draft that ends in `>`, a line redrawn over, a Python `...` or a PowerShell PS2 `>>` never
// matches, so nothing is typed into a partial input. A lone `>` is PowerShell's continuation prompt, not a prompt.
const PROMPTS: readonly RegExp[] = [
  /^PS [A-Za-z]:[\\/][^>]*>$/,
  /^[A-Za-z]:[\\/][^>]*>$/,
  /^[^@\s]+@[^:\s]+:[^$#]*[$#]$/,
  /^~[\\/][^>]*>$/,
  /^[$#%]$/,
];

/**
 * D2 typing gate: true only when the screen's last non-empty line is an empty prompt. A pane that passed the tree
 * check still holds whatever the human typed into it before the TUI died, so a command line is typed only on this
 * positive proof; a screen that cannot be read is no proof.
 */
export function emptyPrompt(screen: string): boolean {
  const lines = screen
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? "";
  return PROMPTS.some((prompt) => prompt.test(last));
}

/** The production snapshot: a kernel read on Windows, `ps` elsewhere (see process-tree.ts). */
export const paneTree: PaneTree = () => listProcessTree();
