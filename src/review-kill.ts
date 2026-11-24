// Killing a reviewer means its whole tree: `omo -p` is a shim with a provider child, so killing the shim leaves the
// child running, holding its provider connection and the RAM that stalls the hourly loop. On Windows `taskkill /T`
// walks the tree; on POSIX the reviewer is spawned as its own process group, so the group is killed instead.

import { execFileSync } from "node:child_process";
import { pidAlive } from "./process-identity.ts";

/** The part of a spawned process a review runner needs: its pid (for a later tree kill) and its own kill. */
export type KillableProcess = { readonly pid?: number; kill(): void };
/** The tree killer; injectable so a failed kill can be exercised without a privileged process. */
export type KillTree = (pid: number | undefined, proc?: KillableProcess) => KillOutcome;
/** Whether the tree kill landed. A failure must keep the recorded identity so a later pass can retry it. */
export type KillOutcome = { readonly ok: true } | { readonly ok: false; readonly why: string };

const reasonOf = (e: unknown): string => {
  const text = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "kill failed";
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
};

/**
 * Kills `pid` and every process it started, then the directly spawned handle when one is given. A taskkill that
 * reports failure for a process already gone is a success; every other failure is returned so the caller can keep
 * the marker and say so.
 */
export function killReviewTree(pid: number | undefined, proc?: KillableProcess): KillOutcome {
  const target = pid ?? proc?.pid;
  let why: string | undefined;
  if (target !== undefined && Number.isInteger(target) && target > 0) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(target), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch (e) {
        why = reasonOf(e);
      }
    } else {
      try {
        process.kill(-target, "SIGKILL");
      } catch {
        // Not a group leader (a caller outside the review runner): kill just the process itself.
        try {
          process.kill(target, "SIGKILL");
        } catch (e) {
          why = reasonOf(e);
        }
      }
    }
  }
  try {
    proc?.kill();
  } catch (e) {
    if (why === undefined) why = reasonOf(e);
  }
  if (why !== undefined && target !== undefined && !pidAlive(target)) return { ok: true };
  return why === undefined ? { ok: true } : { ok: false, why };
}
