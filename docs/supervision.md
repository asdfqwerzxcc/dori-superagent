# Supervision: what runs with Dori, and how it comes back

Dori's always-on half runs outside the sessions, so a closed tab or a dead workspace cannot silence it.

One supervisor owns every long-lived child. The children stay separate processes on purpose: duty is the delivery path
and must not be killable by an exception in update-check or the hourly loop. The watchdog stays separate because it
exists to resurrect the supervisor and cannot resurrect itself.

| Process | Parent | Writes | Log |
| --- | --- | --- | --- |
| `supervisor.ts` | launched by `dori up`, `dori restart`, or the watchdog | `state/supervisor-heartbeat`, `state/supervisor.json`, `state/gateway-heartbeat` (compatibility) | `state/supervisor.log` |
| `discord-gateway.ts` | supervisor | `state/gateway-ws-heartbeat` (each Discord heartbeat ack) | `state/gateway.log` |
| `duty`, `loop`, `update-check`, `dori-ensure-up.ts` | supervisor | their own files under `state/`, `duty/`, `loop/` | `state/loops.log` |
| `gateway-watchdog.ts` | launcher | `state/gateway-watchdog-heartbeat`, `state/watchdog-supervisor.json` | `state/gateway-watchdog.log` |

The repo owns each program under `src/supervisors/`; `~/.dori/bin/*.ts` is a two-line shim into the installed checkout, so a
launcher or the watchdog keeps spawning the same path it always did.

## `dori status`

```
RUNTIME herdr (from config)
lead=w9:p1 duty=- home=C:\Users\USER\.dori
STALE <role>=<ref>: pane not found          # only when roles.json names a dead pane
SUPERVISED supervisor up pid=12836 hb=1s units=discord-gateway:4528,duty:18000,loop:19416,update-check:3140,ensure-up:8368
WATCHDOG up pid=5204 hb=0s
ENSURE-UP up pid=8368 hb=1s
```

The supervisor is `up` only when its recorded pid is alive **and** its heartbeat is inside the 90 s window. The watchdog
line is separate: its own heartbeat and record, one stale threshold, one grace window. `ENSURE-UP off (ensure-up.off)`
means the loop is deliberately off. A role whose pane is gone is printed as `STALE`, and `dori send <role>` refuses it
instead of queueing text nowhere.

## `dori restart`

Kills the supervisor and every child process by command line, so a supervisor killed on its own does not leave five
orphans behind. It starts one supervisor again and returns only when the supervisor heartbeat, `gateway-ws-heartbeat` (the Discord socket actually acked) and all five unit pids are newer than the moment the restart
began. `RESTART INCOMPLETE` (exit 1) means one of them did not come back, and the lines above the verdict say which.
A live watchdog is left alone; a missing one is started.

Measured on this host (Windows, herdr 0.9.5, 2026-11-16):

- Swap from the pre-merge pair: `RESTARTED killed=7 ms=5818 ws=2s` (the two old supervisors and their five children).
  `GATEWAY_READY` landed at 10:51:00, one second after the new supervisor started.
- Killing only the supervisor and running `dori restart`: `RESTARTED killed=0 ms=3853 ws=0s`; all five units came
  back with new pids. Bun on Windows exits the children with the supervisor, so the command-line cleanup found nothing
  left to kill; the new supervisor rebuilt them.
- The ensure-up loop came back with the supervisor, no separate step.
- The watchdog recovered a killed supervisor unaided in 80 s: `WATCHDOG_STALE supervisor=94s ws=82s`, then
  `WATCHDOG_SPAWN supervisor pid=3716`; the five units returned with new pids.

## Host guard compatibility

The `DoriGatewayGuard` scheduled task runs `bin/ensure-gateway.ps1` every minute and is the cover for "the watchdog
itself dies". The merged supervisor keeps `state/gateway-heartbeat` fresh in the same 30 s beat as
`state/supervisor-heartbeat`, so the old guard never sees a missing gateway. The script matches only `bin/supervisor.ts`
(or the repo's `src/supervisors/supervisor.ts`), reads `supervisor-heartbeat`, and starts `bin/supervisor.ts`; it no
longer matches or starts the pre-merge `gateway-supervisor.ts`. `state/gateway-heartbeat` remains a compatibility write
for pre-merge launchers and monitors.

Verified on this host (2026-11-16):

- Fresh guard run while the stack was healthy: task result 0; supervisor `10584` and children
  `6040,6060,10868,11176,19364` unchanged; one supervisor, one gateway.
- After `supervisor-heartbeat` was aged 200 s: the guard replaced `10584` with `17900`, the old children exited, and the
  new units were `6544,18500,2036,19272,15744`; no `gateway-supervisor.ts` / `loops-supervisor.ts` process appeared;
  `GATEWAY_READY` at 10:57:58 and `gateway-heartbeat` fresh on the new supervisor.

## ensure-up

The supervisor owns `dori-ensure-up.ts`; it starts it when `state/ensure-up.off` is absent and keeps it out of the
supervised set while the file exists. Every 20 s the loop checks whether a workspace labelled `dori` holds two panes
with a live agent; only when none does it runs `dori up`. One loop per home is enforced by `state/ensure-up.lock` (a
dead holder's lock is taken over), so two supervisors cannot raise two workspaces. A pane-mode `dori up` (loops not
supervised) starts the ensure-up loop itself.

## Roles under supervision

The duty and hourly loops are supervisor children, not panes. `dori up` under a live supervisor opens only the lead and
duty panes and drops `duty-loop` / `hourly-loop` from `roles.json`; a stale role left by an older layout is removed with
`dori role <role> -` (clearing accepts the loop roles; registering still accepts only lead and duty).

## What the merge removed

`gateway-supervisor.ts` and `loops-supervisor.ts` no longer exist. `state/loops-heartbeat`, `state/gateway-supervisor.json`
and `state/loops-supervisor.json` are neither read nor written; `state/gateway-heartbeat` stays as the compatibility
write for the Windows boot guard, and `gateway.log` / `loops.log` remain the child-output logs. A `dori restart` still
matches the old supervisor command lines once, so a host that is still running the pre-merge pair can be swapped with
one command.

## Tests on Windows

`bun test ./test/` is green here except for guards that name win32 and why:

- `install.test.ts`: `install.sh` is a POSIX shell installer run through bash; the POSIX CI jobs cover it.
- `shq.test.ts`: the subject is the single-quote form a POSIX `sh` reads; Windows has no `sh`.
- `runtime-select.test.ts` ("non-executable file named hc"): Windows has no executable bit, so `accessSync(X_OK)` passes
  for any file on PATH.
- `e2e.test.ts`: the fake agent is a POSIX shell fixture that a Windows herdr pane cannot execute; the Linux/macOS CI
  jobs run the real-herdr end-to-end.
- `gate.test.ts` checks the private 0600 diagnostic only on POSIX; `statSync` synthesizes 0o666 on Windows.
