import { listAllProcesses } from "./lead-process-list.ts";
import { startedNear } from "./process-liveness.ts";
import type { Exec } from "./runtime/exec.ts";

/** True only while the pid is the launcher process itself: its unique script path and creation time must match. */
export const launcherStillOurs = async (
  exec: Exec,
  pid: number,
  startedAt: number,
  launcher: string,
): Promise<boolean> => {
  const procs = await listAllProcesses(exec);
  const row = procs?.find((p) => p.pid === pid);
  return row?.command.includes(launcher) === true && startedNear(pid, startedAt, 30_000);
};
