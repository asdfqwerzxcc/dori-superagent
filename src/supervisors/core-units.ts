/**
 * The always-on core units, in supervisor start order. The supervisor's specs and the restart/up expectations both read
 * this list, so a core-unit rename cannot leave the restart waiting for a stale name.
 */
export const CORE_UNITS = ["discord-gateway", "duty", "loop"] as const;

export type CoreName = (typeof CORE_UNITS)[number];
