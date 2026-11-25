import { pidAlive } from "./process-liveness.ts";
import type { EnsureUpDedupe } from "./ensure-up-dedupe.ts";
import type { RecordedChild } from "./supervisor-run.ts";

/** Picks the keeper from two cleanup passes; the second pass wins, and a dead or reused pid is not carried. */
export const mergeEnsureUpDedupe = (
  first: EnsureUpDedupe,
  second: EnsureUpDedupe,
  alive: (pid: number) => boolean = pidAlive,
  same: (child: RecordedChild) => boolean,
): EnsureUpDedupe => {
  const valid = (d: EnsureUpDedupe): boolean =>
    d.kept !== undefined && alive(d.kept) && (d.keptAt === undefined || same({ pid: d.kept, at: d.keptAt }));
  const secondKept = valid(second) ? second.kept : undefined;
  const carried = valid(first) ? first.kept : undefined;
  const kept = secondKept ?? carried;
  const keptAt = kept === undefined ? undefined : kept === secondKept ? second.keptAt : first.keptAt;
  const killed = [...new Set([...first.killed, ...second.killed])].filter((pid) => pid !== kept);
  const failed = [...new Set([...(first.failed ?? []), ...(second.failed ?? [])])].filter(
    (pid) => pid !== kept && !killed.includes(pid) && alive(pid),
  );
  const unverified = [...new Set([...(first.unverified ?? []), ...(second.unverified ?? [])])].filter(
    (pid) => pid !== kept && !killed.includes(pid) && !failed.includes(pid) && alive(pid),
  );
  return {
    ...(kept === undefined ? {} : { kept }),
    ...(keptAt === undefined ? {} : { keptAt }),
    killed,
    ...(failed.length === 0 ? {} : { failed }),
    ...(unverified.length === 0 ? {} : { unverified }),
  };
};

/** The one line a startup or a restart prints when it reduced several ensure-up processes to one. */
export const dedupeLine = (d: EnsureUpDedupe): string | undefined => {
  const failed = d.failed ?? [];
  const unverified = d.unverified ?? [];
  if (d.killed.length === 0 && failed.length === 0 && unverified.length === 0) return undefined;
  const parts = [`kept=${d.kept ?? "none"}`];
  if (d.killed.length > 0) parts.push(`killed=${d.killed.join(",")}`);
  if (failed.length > 0) parts.push(`failed=${failed.join(",")}`);
  if (unverified.length > 0) parts.push(`unverified=${unverified.join(",")}`);
  return `ENSURE_UP dedupe ${parts.join(" ")}`;
};
