// Process identity shared by the receipt locks and the review queue: a pid alone is never evidence that it is still
// the process a record named. These helpers read the OS creation time, so a reused pid fails the identity check.

import { hostname } from "node:os";
import { pidAlive, processStartTimeMs } from "./process-liveness.ts";

export const HOSTNAME = hostname();

export { pidAlive };

/** OS process creation time in Unix ms, or null when it cannot be read (identity checks fail closed). */
export const readProcessStartTime = processStartTimeMs;

let ownStartTime: number | null | undefined;
/** The current process's start time never changes; a foreign pid is re-read every time so reuse cannot be cached. */
export const processStartTime = (pid: number): number | null => {
  if (pid !== process.pid) return readProcessStartTime(pid);
  if (ownStartTime === undefined) ownStartTime = readProcessStartTime(pid);
  return ownStartTime;
};
