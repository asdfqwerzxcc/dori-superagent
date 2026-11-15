# Supervision: what runs with Dori, and how it comes back

Dori's always-on half runs outside the sessions, so a closed tab or a dead workspace cannot silence it.

| Process | Parent | Writes | Log |
| --- | --- | --- | --- |
| `gateway-supervisor.ts` | launched by `dori up`, `dori restart`, or the watchdog | `state/gateway-heartbeat`, `state/gateway-supervisor.json` | `state/gateway.log` |
| `discord-gateway.ts` | gateway supervisor | `state/gateway-ws-heartbeat` (each Discord heartbeat ack) | `state/gateway.log` |
| `loops-supervisor.ts` | same as the gateway supervisor | `state/loops-heartbeat`, `state/loops-supervisor.json` | `state/loops.log` |
| `duty`, `loop`, `update-check` | loops supervisor | their own files under `state/`, `duty/`, `loop/` | `state/loops.log` |
| `dori-ensure-up.ts` | loops supervisor (or `dori up` when it is missing) | `state/ensure-up-heartbeat`, `state/ensure-up.json`, lock `state/ensure-up.lock` | stdout of the supervisor |
| `gateway-watchdog.ts` | same as the gateway supervisor | `state/gateway-watchdog-heartbeat`, `state/watchdog-supervisor.json` | `state/gateway-watchdog.log` |

The repo owns each program under `src/supervisors/`; `~/.dori/bin/*.ts` is a two-line shim into the installed checkout, so a
launcher or the watchdog keeps spawning the same path it always did.

## `dori status`

```
RUNTIME herdr (from config)
lead=w9:p1 duty=- home=C:\Users\USER\.dori
STALE <role>=<ref>: pane not found          # only when roles.json names a dead pane
SUPERVISED gateway  up pid=12836 hb=1s units=discord-gateway:4528
SUPERVISED loops    up pid=6720 hb=1s units=duty:18000,loop:19416,update-check:3140,ensure-up:8368
SUPERVISED watchdog up pid=5204 hb=0s
ENSURE-UP up pid=8368 hb=1s
```

A supervisor is `up` only when its recorded pid is alive **and** its heartbeat is inside the window (90 s, 120 s for the
loops). `ENSURE-UP off (ensure-up.off)` means the loop is deliberately off. A role whose pane is gone is printed as
`STALE`, and `dori send <role>` refuses it instead of queueing text nowhere.

## `dori restart`

Kills the three supervisor trees by command line, starts them again from the home's shims, and returns only when
`gateway-heartbeat`, `gateway-ws-heartbeat` (the Discord socket actually acked) and `loops-heartbeat` are newer than the
moment the restart began. It then checks the six child pids and the ensure-up loop; `RESTART INCOMPLETE` (exit 1) means
one of them did not come back, and the lines above the verdict say which.

Measured on this host (Windows, herdr 0.9.5, 2026-11-15):

- `dori restart` after killing both supervisors by hand: **1333 ms** until all heartbeats were fresh and every child pid
  was up (`killed=1` = the watchdog it also replaces).
- Gateway `GATEWAY_READY` 1 s after the restart; all seven processes (six + ensure-up) had new pids and records.
- The ensure-up loop came back with the loops supervisor, no separate step.

## ensure-up

`dori up` (and the loops supervisor) starts `dori-ensure-up.ts` when `state/ensure-up.off` is absent. Every 20 s it
checks whether a workspace labelled `dori` holds two panes with a live agent; only when none does it runs `dori up`.
One loop per home is enforced by `state/ensure-up.lock` (a dead holder's lock is taken over), so two supervisors cannot
raise two workspaces. `state/ensure-up.off` makes the loop idle and `dori status` print `ENSURE-UP off`.

## Roles under supervision

The duty and hourly loops are supervisor children, not panes. `dori up` under a live loops supervisor opens only the
lead and duty panes and drops `duty-loop` / `hourly-loop` from `roles.json`; a stale role left by an older layout is
removed with `dori role <role> -` (clearing accepts the loop roles; registering still accepts only lead and duty).

## Tests on Windows

`bun test ./test/` is green here except for guards that name win32 and why:

- `install.test.ts`: `install.sh` is a POSIX shell installer run through bash; the POSIX CI jobs cover it.
- `shq.test.ts`: the subject is the single-quote form a POSIX `sh` reads; Windows has no `sh`.
- `runtime-select.test.ts` ("non-executable file named hc"): Windows has no executable bit, so `accessSync(X_OK)` passes
  for any file on PATH.
- `e2e.test.ts`: the fake agent is a POSIX shell fixture that a Windows herdr pane cannot execute; the Linux/macOS CI
  jobs run the real-herdr end-to-end.
- `gate.test.ts` checks the private 0600 diagnostic only on POSIX; `statSync` synthesizes 0o666 on Windows.
