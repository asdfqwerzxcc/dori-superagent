// Legacy cleanup: an older dori spawned a reviewer whose whole tree (a shim plus its provider child) had to die with
// it. The default review path spawns nothing, so this survives only for `--legacy-kill` and a lane drop with that
// flag. On Windows `taskkill /T` walks the tree; on POSIX the reviewer ran as its own process group.

import { execFileSync } from "node:child_process";
import { pidAlive } from "./process-identity.ts";

/** Whether the tree kill landed. A failure must keep the recorded identity so a later legacy pass can retry it. */
export type KillOutcome = { readonly ok: true } | { readonly ok: false; readonly why: string };

const reasonOf = (e: unknown): string => {
  const text = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "kill failed";
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
};

/**
 * Kills `pid` and every process it started. A taskkill that reports failure for a process already gone is a success;
 * every other failure is returned so the caller can keep the marker and say so.
 */
export function killReviewTree(pid: number | undefined): KillOutcome {
  const target = pid;
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
        try {
          process.kill(target, "SIGKILL");
        } catch (e) {
          why = reasonOf(e);
        }
      }
    }
  }
  if (why !== undefined && target !== undefined && !pidAlive(target)) return { ok: true };
  return why === undefined ? { ok: true } : { ok: false, why };
}
