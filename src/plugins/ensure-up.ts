import { acquireEnsureUpLock, ensureUpCheck, startEnsureUpBeat } from "../supervisors/ensure-up.ts";
import { ensureUpOff } from "../supervisors.ts";
import type { EnsureUpState } from "../supervisors/ensure-up.ts";
import type { Plugin } from "./plugin.ts";

let locked = false;
let warned = false;
let last: EnsureUpState | "" = "";

export const ensureUpPlugin: Plugin = {
  name: "ensure-up",
  intervalMs: 20_000,
  async run(ctx) {
    if (!locked) {
      locked = acquireEnsureUpLock(ctx.home);
      if (!locked) {
        if (!warned) {
          warned = true;
          ctx.log("ENSURE_UP already running in another child");
        }
        return;
      }
      startEnsureUpBeat(ctx.home, ctx.startedAt);
    }
    await ensureUpCheck({
      home: ctx.home,
      log: ctx.log,
      startedAt: ctx.startedAt,
      report: (state, line) => {
        if (state === last) return;
        last = state;
        ctx.log(line);
      },
    });
  },
  status: (c) => (ensureUpOff(c.home) ? "off" : ""),
};
