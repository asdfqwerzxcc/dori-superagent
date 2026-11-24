import { need, USAGE, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { ROLES } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import { parseRef } from "./runtime/types.ts";
import { RESERVED_KEYS, type Role } from "./store-types.ts";

/** `dori role <name> [REF|-]`: registers this session (or the given ref) under a role, or clears it with `-`. */
export function runRole(d: Deps, a: Args): number {
  const role = need(a.pos[1], "role") as Role;
  const given = a.pos[2];
  if (given === "-") {
    // Clearing accepts the loop roles too: a supervised home registers only lead (and duty on a pane), and an
    // older roles.json may still hold stale loop panes that no `up` will open again.
    if (!RESERVED_KEYS.includes(role)) throw new Refusal(`role must be one of ${RESERVED_KEYS.join(", ")}`);
    d.store.clearRole(role);
    console.log(`ROLE ${role}=-`);
    return 0;
  }
  if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
  const ref = given === undefined ? d.runtimes.selfAny(process.env) : parseRef(given);
  if (given !== undefined && ref === undefined)
    throw new Refusal(`${given} is not a session ref (w1:p3, herdr:w1:p3 or hc:t7)`);
  if (ref === undefined) throw new Refusal(`missing session ref (not inside herdr or hc?)\n\n${USAGE}`);
  d.store.setRole(role, ref);
  console.log(`ROLE ${role}=${refText(ref)}`);
  return 0;
}
