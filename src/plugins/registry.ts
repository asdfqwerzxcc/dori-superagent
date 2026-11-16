import { ensureUpPlugin } from "./ensure-up.ts";
import { gatewayCatchupPlugin } from "./gateway-catchup.ts";
import { updateCheckPlugin } from "./update-check.ts";
import type { Plugin } from "./plugin.ts";

// Every plugin is imported here by hand. `bun build`, `tsc` and the test suite must see each one statically, so there
// is no directory scan and no dynamic import: a plugin that exists is a line in this list, nothing else.

export const PLUGINS: readonly Plugin[] = [ensureUpPlugin, updateCheckPlugin, gatewayCatchupPlugin];

export const pluginByName = (name: string): Plugin | undefined => PLUGINS.find((p) => p.name === name);
