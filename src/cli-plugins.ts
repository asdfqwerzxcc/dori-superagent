import { PLUGINS, pluginByName } from "./plugins/registry.ts";
import { pluginListLines, setPluginEnabled, writePluginsConfig } from "./plugins/state.ts";
import { Refusal } from "./refusal.ts";

export function pluginCommand(home: string, sub: string | undefined, name: string | undefined): number {
  if (sub === undefined || sub === "list") {
    for (const line of pluginListLines(home)) console.log(line);
    return 0;
  }
  if (sub !== "enable" && sub !== "disable")
    throw new Refusal(`unknown plugin command ${sub}: list, enable or disable`);
  if (name === undefined || pluginByName(name) === undefined)
    throw new Refusal(`unknown plugin ${name ?? ""}: one of ${PLUGINS.map((p) => p.name).join(", ")}`);
  writePluginsConfig(home, setPluginEnabled(home, name, sub === "enable"));
  console.log(`PLUGIN ${name} ${sub === "enable" ? "enabled" : "disabled"}`);
  return 0;
}
