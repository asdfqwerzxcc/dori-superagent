// A pane can outlive the TUI that ran in it, and the runtime keeps answering with the last status word it saw: on
// 2026-11-26 a lane killed every bun.exe on the host and herdr still reported the lead's pane as `working` for 90
// minutes. The pane's own process tree is the proof: a pane rooted in a shell with no child at all has nothing in
// front of it, so no agent can be alive there.

import { listProcessTree, normalizeExe, type ProcNode } from "../process-tree.ts";
import { SHELLS } from "./foreground.ts";

/** The OS process snapshot the check reads. `undefined` is an unreadable snapshot: doubt, never death. */
export type PaneTree = () => Promise<readonly ProcNode[] | undefined>;

// As a pane root, cmd.exe is the prompt the pane opened with, not the `cmd /c` child of an agent that SHELLS guards
// against; every other shell a pane opens on is already in SHELLS.
const PANE_SHELLS: ReadonlySet<string> = new Set([...SHELLS, "cmd"]);

/**
 * D2: true only when the pane's root (`process_info.shell_pid`) is a shell that has no child, so nothing can be running
 * in front of it. A missing root pid, a root that is not a shell, and an unreadable snapshot are all doubt: this check
 * proves death and never guesses it, because a wrong `true` revives a lead that is still talking.
 */
export async function tuiExited(tree: PaneTree, rootPid: number | undefined): Promise<boolean> {
  if (rootPid === undefined) return false;
  let nodes: readonly ProcNode[] | undefined;
  try {
    nodes = await tree();
  } catch {
    return false;
  }
  if (nodes === undefined) return false;
  const root = nodes.find((node) => node.pid === rootPid);
  if (root === undefined || !PANE_SHELLS.has(normalizeExe(root.exe))) return false;
  return !nodes.some((node) => node.parent === rootPid);
}

/** The production snapshot: a kernel read on Windows, `ps` elsewhere (see process-tree.ts). */
export const paneTree: PaneTree = () => listProcessTree();
