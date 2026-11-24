import { join } from "node:path";
import type { Deps } from "./harness.ts";
import { HOUR } from "./loop-audit.ts";
import type { LoopRun } from "./store-types.ts";

const QUIET_HOURS = 6;

type LoopStatus = NonNullable<LoopRun["status"]>;
const quietPath = (d: Deps) => join(d.store.root, "state", "loop-quiet.json");
const quietKey = (s: LoopStatus) =>
  `lanes ${s.lanes}/${s.maxLanes} open ${s.items.open} decide ${s.items.decide} running ${s.items.running}`;

/** An unchanged hourly status reaches the lead at most once every QUIET_HOURS; anything new goes straight through. */
export async function worthTelling(d: Deps, run: LoopRun): Promise<boolean> {
  if (run.synced.length || run.findings.length || run.started.length || run.held.length || run.asked.length)
    return true;
  const key = quietKey(run.status as LoopStatus);
  const prev = (await Bun.file(quietPath(d))
    .json()
    .catch(() => undefined)) as { key?: string; at?: number } | undefined;
  if (prev === undefined || prev.key !== key) return true;
  return d.now() - (prev.at ?? 0) >= QUIET_HOURS * HOUR;
}

export async function rememberQuiet(d: Deps, run: LoopRun): Promise<void> {
  try {
    await Bun.write(quietPath(d), JSON.stringify({ key: quietKey(run.status as LoopStatus), at: d.now() }));
  } catch {}
}
