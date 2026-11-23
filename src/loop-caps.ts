import { ConfigError, readConfigFile } from "./hooks.ts";

/** The hourly loop's budget: open lanes allowed, and lanes one run may start. */
export type LoopCaps = { readonly maxLanes?: number; readonly maxStarts?: number };

/** The shipped budget; the loop's own host guard (load above cores, free memory under 10%) still stops every start. */
export const DEFAULT_MAX_LANES = 5;
export const DEFAULT_MAX_STARTS = 2;

function cap(config: Record<string, unknown>, key: "maxLanes" | "maxStarts"): number | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new ConfigError(`config.json: ${key} must be a whole number >= 0`);
  return value;
}

/** `maxLanes`/`maxStarts` from `<root>/config.json`; absent keys stay absent so the loop's own defaults apply. */
export function readLoopCaps(root: string): LoopCaps {
  const config = readConfigFile(root);
  if (config === undefined) return {};
  const maxLanes = cap(config, "maxLanes");
  const maxStarts = cap(config, "maxStarts");
  return { ...(maxLanes === undefined ? {} : { maxLanes }), ...(maxStarts === undefined ? {} : { maxStarts }) };
}

/**
 * The loop's argv: no configured cap leaves `loop` exactly as it was, so the loop's own defaults win. A configured cap
 * is passed as flags, and the other cap is filled from the shipped default.
 */
export function loopArgs(caps: LoopCaps, base: readonly string[]): string[] {
  if (caps.maxLanes === undefined && caps.maxStarts === undefined) return [...base];
  return [
    ...base,
    "--max-lanes",
    String(caps.maxLanes ?? DEFAULT_MAX_LANES),
    "--max-starts",
    String(caps.maxStarts ?? DEFAULT_MAX_STARTS),
  ];
}
