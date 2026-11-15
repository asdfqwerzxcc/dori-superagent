import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { parseRef, type SessionRef } from "./runtime/types.ts";
import { refText } from "./refs.ts";
import { supervisorHealth } from "./supervisors.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

const ROLES_ALL: readonly Role[] = RESERVED_KEYS;
const isRole = (target: string): target is Role => (ROLES_ALL as readonly string[]).includes(target);

/**
 * Where a send goes, in this order: a prefixed ref (`herdr:w1:p3`, `hc:t7`), a role, an open lane key, a bare herdr
 * pane id (`w1:p3`). A lane named `t7` is that lane; the hc terminal t7 is `hc:t7`.
 */
export function resolveTarget(d: Deps, target: string): SessionRef {
  if (target.startsWith("herdr:") || target.startsWith("hc:")) {
    const ref = parseRef(target);
    if (ref) return ref;
    throw new Refusal(`${target} is not a session ref (herdr:w1:p3 or hc:t7)`);
  }
  if (isRole(target)) {
    const ref = d.store.roles()[target];
    if (!ref) throw new Refusal(`no ${target} session registered (dori role ${target} <ref>)`);
    return ref;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.sessionRef;
  const bare = parseRef(target);
  if (bare) return bare;
  throw new Refusal(`unknown target ${target}: not a session ref, role or open lane`);
}

/** Which supervisor unit runs a role's loop in the supervised topology. */
const UNIT: Partial<Record<Role, string>> = { duty: "duty", "duty-loop": "duty", "hourly-loop": "loop" };

/** Where the role's loop really runs, for a refusal that names the process instead of a pane that is not there. */
export function supervisedHint(d: Deps, role: Role): string | undefined {
  const unit = UNIT[role];
  const loops = supervisorHealth(d.store.root).find((h) => h.name === "loops");
  if (loops === undefined || loops.pid === undefined) return undefined;
  const running = unit === undefined ? undefined : loops.units.find((u) => u.name === unit && u.alive);
  const label = role === "hourly-loop" ? "hourly loop" : "duty loop";
  if (loops.alive && running !== undefined)
    return `the ${label} runs under the loops supervisor (pid ${loops.pid}, ${running.name} pid ${running.pid ?? "?"}); it has no pane`;
  if (loops.alive) return `the loops supervisor (pid ${loops.pid}) is up but runs no ${label}`;
  return `the loops supervisor (pid ${loops.pid}) is DOWN`;
}

/** A role whose pane is gone; `dori send` refuses it, internal notices fall back to the lane log. */
export class StaleRole extends Refusal {}

/**
 * resolveTarget, plus a liveness read for a role: a role whose pane is gone is a stale reference, not a target that
 * quietly receives the text or keeps it queued forever. Only role-addressed sends pay for the extra probe.
 */
export async function resolveLiveTarget(d: Deps, target: string): Promise<SessionRef> {
  if (!isRole(target)) return resolveTarget(d, target);
  const ref = d.store.roles()[target];
  const hint = supervisedHint(d, target);
  if (ref === undefined) throw new Refusal(`no ${target} session registered${hint === undefined ? "" : `; ${hint}`}`);
  let gone: boolean;
  try {
    gone = (await d.runtimes.for(ref).probe(ref)).status === "gone";
  } catch {
    // A runtime that cannot answer leaves the role unverified; deliver.ts holds or queues it as it always has.
    return ref;
  }
  if (!gone) return ref;
  throw new StaleRole(
    `role ${target} points at ${refText(ref)}, which no longer exists: the role is stale. ${hint ?? ""}`.trim(),
  );
}
