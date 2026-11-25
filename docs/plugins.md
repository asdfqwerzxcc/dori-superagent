# Plugins: the timed side-jobs, one contract and one child each

A plugin is a timed side-job that runs outside the sessions. It is **not** the delivery path. Every plugin runs as its own
supervisor child, so an exception in a plugin cannot reach duty, the gateway socket or the hourly loop.

In-repo only: the registry is a hand-written list, and nothing under `~/.dori/plugins/` is loaded. A file that is not
imported by `src/plugins/registry.ts` does not exist as far as the build, `tsc` and the test suite are concerned.

## Contract

```ts
type Plugin = {
  name: string;
  intervalMs?: number;              // tick period; absent = the plugin schedules itself in run()
  run(ctx: PluginCtx): Promise<void>; // one tick; a throw is logged and the next tick still runs
  status(ctx: PluginStatusCtx): string; // one read-only phrase for the dori status line
};

type PluginCtx = {
  home: string;        // DORI_HOME
  stateDir: string;    // <home>/state
  now(): number;
  log(line: string): void;
  lockPath: string;    // <home>/state/plugins/<name>.lock; the protocol mutex lives in <name>.lock.d, held for the child's life
  tickPath: string;    // <home>/state/plugins/<name>.tick, rewritten every 30 s by the host
  startedAt: number;
};
```

`src/plugins/plugin.ts` is the contract, `src/plugins/registry.ts` the explicit list, `src/plugins/run.ts` the child entry
(`bun src/plugins/run.ts <name>`). The host holds the lock, writes the liveness tick every 30 s, then calls `run` every
`intervalMs`.

## The registry

| Plugin | Tick | What it does |
| --- | --- | --- |
| `ensure-up` | 20 s | `dori up` when `roles.json`'s lead is missing or its pane is `gone`. Reuses `src/supervisors/ensure-up.ts` and its `state/ensure-up.lock`, so the pane-mode and plugin paths share one lock. Honours `state/ensure-up.off`. |
| `update-check` | 5 min | Checks git and the omo/senpi packages once a day at 04:00 local (`UPDATECHECK_AT_HOUR`); notifies the lead. The 5 min tick exists so a restart cannot skip or drift the 04:00 slot (the next slot is persisted in `state/update-check-next`). |
| `gateway-catchup` | 60 s | Delivers what Discord holds past `state/gateway-last.json` that no inbound file covers. Channels = the keys of `gateway-last.json` (or `DORI_WATCH_CHANNELS` on a cold start). |
| `silence-check` | 60 s | Alerts the lead when a human Discord message stays unanswered: rungs at 5 min, 15 min and every 30 min after that, one per message per rung, keyed by message id in `state/silence-check.json`. Any newer bot message clears it. The alert names the message and the four causes to check: a blocked turn, a stuck child, a prompt that never arrived, a missed catch-up. |

### Why `gateway-catchup` is an addition, not a move

The REST catch-up lives in `~/.dori/bin/discord-gateway.ts`, which is unversioned host code: moving it into `src/` is a
separate lane that would have to re-test the socket path. This lane keeps the in-process timer working and adds the
versioned plugin as a supervised backstop for the failure the timer cannot cover (a wedged or restarted gateway). The two
cannot push one message twice: the plugin skips any message whose `state/inbound/<id>.json` already exists, and skips
messages younger than 10 s (the socket owns those). The residual race is a message older than 10 s that the gateway's own
timer is delivering in the same second; both paths then write the same inbound file and push the lead once each, which is
visible in the gateway's log (its pane, or `loops.log` when running headless) as two `LEAD_PUSH` lines.

## Process model and files

The supervisor owns the three core children (`discord-gateway`, `duty`, `loop`) and one child per enabled plugin. It
re-reads `state/plugins.json` **every 5 s** while a plugin runs: disabling stops that child, enabling starts one. An exit
is restarted after 5 s.

| File | Written by | Meaning |
| --- | --- | --- |
| `state/plugins.json` | `dori plugin enable/disable` | `{ "disabled": ["name", ...] }`; missing file = everything enabled |
| `state/plugins/<name>.json` | supervisor | `{ name, pid, startedAt, at }`, the record of the running child; removed when the child is stopped |
| `state/plugins/<name>.tick` | plugin child | `{ pid, at }`, rewritten every 30 s; a hung child cannot fake it |
| `state/plugins/<name>.lock` | plugin child | the historical compatibility file, `{ version: 1, pid, at, startedAt }`; the owner mirrors its record here so an older release's child reads a live pid and waits instead of meeting a directory. A live old-format holder with a fresh `.tick` is waited out; a dead holder, a holder whose tick is stale or missing while its claim is older than three beats, or an unreadable/truncated file is taken over (a corrupt file is replaced). A directory an earlier layout left at this path is migrated once its owner is stale |
| `state/plugins/<name>.lock.d/owner.json` | plugin child | the lock directory: one child per plugin per home. `owner.json` is written to a temp file and renamed into place. A stale takeover takes a per-generation `O_EXCL` token, reads **only the directory's** owner inside it, and only then renames the directory, so a delayed loser cannot rename a fresh owner's lock and a dead historical file can never supply the generation. A dead holder, a 2 s start-time mismatch, or a null/corrupt start older than 30 s is stale; a fresh null start and an unreadable start are doubt and stay held. An ownerless directory is a claim in progress for 30 s, then recoverable. The rule applies to every plugin child, not only ensure-up |
| `state/plugins/<name>.contenders/<pid>.json` | plugin child that lost the lock | `{ pid, at }` with the pid's OS start time, refreshed every 5 s; the waiting child does not write the shared tick. `dori up`/`dori restart` ends ensure-up's contenders but the kept loop (the lock holder is never ended in favour of an idle child; a failed kill stays listed as `failed=`); another plugin's contenders are left for that plugin's own host. Only a disabled plugin makes the waiting child exit |
| `state/silence-check.json` | `silence-check` | `{ <channel>: { messageId, rung } }`, the last rung fired for that channel's newest unanswered human message |

`dori status` prints one line per **enabled** plugin, so disabling removes exactly that line:

```
PLUGIN ensure-up up pid=8368 hb=2s
PLUGIN update-check up pid=3140 hb=3s (next 04:00)
PLUGIN gateway-catchup up pid=9977 hb=4s
PLUGIN silence-check up pid=9981 hb=5s (1 channel)
```

A plugin is `up` only when its recorded pid is alive **and** its freshest beat is inside the 90 s window. `dori plugin
list` prints disabled entries too (`PLUGIN <name> disabled`).

## What must never become a plugin

- `duty` and the hourly loop: the delivery path. A plugin exception must never be able to silence delivery.
- `gateway-watchdog`: it exists to resurrect the supervisor and cannot resurrect itself.
- `discord-gateway`: the socket and the inbound delivery path.
- the supervisor itself, and every `dori` CLI command.

Those stay core children of the supervisor or foreground commands.

## How to add one

1. Write `src/plugins/<name>.ts` exporting a `Plugin`. No top-level side effects: the module must load on its own.
2. Put any lock/beat/result files under `<home>/state/` (or use `ctx.lockPath` / `ctx.tickPath`).
3. Add it to `PLUGINS` in `src/plugins/registry.ts` — in registry order; that order is the `dori status` order.
4. Add `src/plugins/run.ts`-level tests only where the plugin has logic; the supervisor restart/disable behaviour is
   already covered by `test/plugin-supervisor.test.ts`.
5. Document the tick, the files it writes and what it may never block in this file.

The supervisor needs no edit: it spawns `PLUGINS.map(...)`.

## Tests

- `test/plugins.test.ts`: registry resolution, `state/plugins.json` enable/disable, a throwing plugin's tick loop, the
  runner lock, and the `dori status` / `dori plugin list` lines.
- `test/plugin-supervisor.test.ts`: a child restarted 5 s after exit, one plugin's crash not touching another's child, and
  disable stopping the running child.
- `test/silence-check.test.ts`: the pure rung decision at fixed timestamps (4/6/16 min, duplicate, clear, older bot
  message), the alert block, one alert per rung through the state file, and a Discord error logging one line.
