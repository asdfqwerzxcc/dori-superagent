import { ConfigError, readConfigFile } from "../hooks.ts";
import { openUnitPanes, type UnitPanes } from "./ops-panes.ts";

/**
 * `supervisors.panes` from `<home>/config.json`: the unit panes (default) or the headless children. An absent key is
 * the historical pane mode, so an untouched config keeps today's behaviour.
 */
export function readUnitPanes(home: string): boolean {
  const config = readConfigFile(home);
  if (config === undefined) return true;
  const raw: unknown = Reflect.get(config, "supervisors");
  if (raw === undefined) return true;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("config.json: supervisors must be an object");
  const panes: unknown = Reflect.get(raw, "panes");
  if (panes === undefined) return true;
  if (typeof panes !== "boolean")
    throw new ConfigError(`config.json: supervisors.panes must be true or false, got ${JSON.stringify(panes)}`);
  return panes;
}

/** The configured unit mode: the one token `dori up` and `dori restart` print as `units=...`. */
export const unitMode = (home: string): "panes" | "headless" => (readUnitPanes(home) ? "panes" : "headless");

export type UnitPaneLayerOptions = {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  /** Test seams: the config read and the runtime probe, so both launch paths are proven without a runtime. */
  readonly read?: (home: string) => boolean;
  readonly open?: (o: UnitPaneLayerOptions) => Promise<UnitPanes | undefined>;
};

/**
 * The pane layer the supervisor uses, or undefined for the headless children. `supervisors.panes: false` turns panes
 * off without asking a runtime; an unreadable value keeps the default pane mode behind one warning line.
 */
export async function unitPaneLayer(o: UnitPaneLayerOptions): Promise<UnitPanes | undefined> {
  let wanted = true;
  try {
    wanted = (o.read ?? readUnitPanes)(o.home);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    o.log(`SUPERVISED units_config_invalid reason=${e.message.split("\n")[0] ?? ""} panes=1`);
  }
  if (!wanted) {
    o.log("SUPERVISED units headless reason=config supervisors.panes=false");
    return undefined;
  }
  return (o.open ?? openUnitPanes)({ home: o.home, env: o.env, log: o.log, sleep: o.sleep });
}
