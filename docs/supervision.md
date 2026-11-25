# Supervision: what runs with Dori, and how it comes back

Dori's always-on half runs outside the sessions, so a closed tab or a dead workspace cannot silence it.

One supervisor owns every long-lived child. The children stay separate processes on purpose: duty is the delivery path
and must not be killable by an exception in update-check or the hourly loop. The watchdog stays separate because it
exists to resurrect the supervisor and cannot resurrect itself. The timed side-jobs (`ensure-up`, `update-check`,
`gateway-catchup`) are plugins and run as their own supervisor children; see [plugins.md](plugins.md).

| Process | Parent | Writes | Log |
| --- | --- | --- | --- |
| `supervisor.ts` | launched by `dori up`, `dori restart`, or the watchdog | `state/supervisor-heartbeat`, `state/supervisor.json`, `state/gateway-heartbeat` (compatibility) | `state/supervisor.log` |
| `discord-gateway.ts` | supervisor | `state/gateway-ws-heartbeat` (each Discord heartbeat ack) | pane output, else `state/gateway.log` |
| `duty`, `loop` | supervisor | their own files under `state/`, `duty/`, `loop/` | pane output, else `state/loops.log` |
| `plugins/run.ts <name>` | supervisor (one per enabled plugin) | `state/plugins/<name>.json`/`.tick`/`.lock`, plus its own `state/` files | pane output, else `state/loops.log` |
| `gateway-watchdog.ts` | launcher | `state/gateway-watchdog-heartbeat`, `state/watchdog-supervisor.json` | `state/gateway-watchdog.log` |

The watchdog treats a stale supervisor heartbeat as a whole-stack failure, but a stale Discord socket alone costs only
the gateway child: the supervisor restarts that unit in place, so a socket reconnect does not churn the stack.

## Unit panes

When the chosen runtime answers (`herdr`, or `hc` when it is the selected kind), each supervisor child runs as a plain
command in its own pane instead of a headless pipe, so `herdr pane list` shows the always-on half:

- **Where**: one workspace labelled `dori-ops` on herdr, or one `dori.group=dori-ops` label group on hc. Every unit gets
  its own tab/pane; herdr's workspace root shell becomes the first unit's pane, later units use `tab create --no-focus`.
- **Title**: the pane label is the unit name (`discord-gateway`, `duty`, `loop`, and every enabled plugin).
- **Log**: `herdr pane read <pane> --lines 200` (or `hc read <terminal>`) is the unit's log in this mode; headless
  children keep writing `state/gateway.log` / `state/loops.log`.
- **No duplicates**: before opening a pane, the supervisor looks for every pane with the unit's title in the ops
  workspace and adopts the one whose own shell subtree holds the unit process, matched by pid and command: herdr reports
  a foreground command line whose interpreter is the unit's own program and whose argv is exactly the unit's script and
  args, and the pane's `shell_pid` plus the parent links confirm its `bun` child; hc reports the terminal's foreground
  command line against the same interpreter. Any foreground entry that cannot be identified as the pane's own shell is
  doubt, even when a bun child exists and even when herdr reports no pid for it; when herdr reports no readable command
  line for the entry in front, the shell's sole bun child is accepted (a path form herdr reports differently must not
  leave the unit unplaced forever). hc has no process tree, so a foreground it cannot name is doubt: if this supervisor
  typed into that pane, its pid is the unit; otherwise the pane is closed after a bounded wait (10 s when it is the only
  candidate, `_pane_doubt_closed`) and replaced, so a foreign bun cannot suppress the unit and an unnameable unit still
  starts. When a named or hinted pane already is the unit, an unnamed hc leftover is closed at once (duplicate cleanup,
  no wait) and a herdr leftover is only logged (`_pane_doubt_left`).
  A dead unit restarts in that same pane; a pane that refuses the command is closed (retried) and only a confirmed close
  is replaced. A process list that cannot be read waits and retries placement, and a typed pane that will not close
  waits too (`_pane_close_held`), because its pending line could still run. A fallback clears only the recorded pane,
  not the unit, so a headless child that fails to start still leaves a dead record instead of no record.
- **Start retry**: a command line typed into a shell can be swallowed while the shell is still starting or still
  finishing its previous job. The first typed line gets 10 s (the old wait's budget, kept for a slow bun start under
  antivirus or load; a unit seen by the read just before the close is adopted), then its pane is **closed with that
  pending input** and the next line goes into a fresh pane after a 1 s, then 2 s backoff (the 4 s cap applies only when
  more attempts are configured; three attempts at most). A line is never typed twice into one shell, so a pending first
  line can never run later as an untracked copy, and a pane that will not close is waited on instead of replaced by a
  headless copy. The typed panes are persisted in `state/panes-pending.json`, so a `dori restart` in the middle of a
  start window closes that pane instead of typing over the pending line. The file is replaced atomically (temp file
  plus rename) and a failed write is logged; if it cannot be read, every stopped pane is treated as possibly holding a
  pending line and is closed before reuse, so an unreadable file costs a reopen but never a duplicate line. While the
  file is unreadable the supervisor does not write a new set at all (a filtered set would drop panes it never scanned);
  it stays in close-before-reuse mode until a restart reads a readable file. A failed write replaces the file with
  `{}` (valid JSON, read as unreadable), and if even that fails it leaves `panes-pending.json.degraded`, which also
  reads as unreadable, so a restart still fails safe; only when the marker cannot be written either does the stale set
  remain. A missing state directory is unknown rather than a trusted empty set. An adopted unnamed hc pane stays in the
  set, so a restarted supervisor adopts the same live unit again instead of closing and recreating it after 10 s. The 30 s budget covers the reuse of an existing pane, every `open`, and every line after the first; a pane
  opened past the deadline is closed without a line being typed. All units share one `dori-ops` workspace even when
  they start at once.
- **Fallback**: a missing runtime, no runtime on PATH, or a runtime that does not answer at startup logs one
  `SUPERVISED panes_unavailable ... headless=1` line and keeps the headless children. A pane that fails later (after its
  close was confirmed) logs `SUPERVISED <unit>_pane_fallback ...` and falls back; an unreadable process tree logs
  `_pane_unknown` once and keeps retrying placement instead of starting a second copy. `dori restart` and `dori up` then
  print `UNITS panes=<live placed>/<expected> headless=<units|none> dead=<units|none> missing=<units|none>`: `panes`
  counts a unit recorded in a pane whose unit pid is alive (the runtime pane itself is not re-queried), `dead` counts any
  recorded unit whose pid died (with or without a pane), and `headless` counts a recorded unit without a pane whose pid
  is alive. In `up`, a supervisor that started less than 30 s ago is labelled `UNITS snapshot=startup` (its units may
  still be registering), and a dead supervisor record or a headless home prints no `UNITS` line; `restart` always prints
  it, with `units=headless` naming every unit headless. Unit, pane and log names are stripped of terminal control
  characters before they reach any line, including the `_pane_*` log lines and the restart's missing parts. The core
  names come from one list shared by the supervisor and the restart/up expectations.
- **Restart**: killing a unit process is noticed within a second and the unit is started again in its pane after the
  usual 5 s delay; `dori restart` kills and restarts the supervisor, and the panes are reused, not duplicated.

**Headless option**: `supervisors.panes: false` in `$DORI_HOME/config.json` turns the pane layer off. No `dori-ops`
workspace or unit pane is created; the same core and plugin children run as the headless processes they already fall
back to, with their output in `state/gateway.log` and `state/loops.log`. `dori status` and `state/supervisor.json` read
the same in either mode (the units simply carry no `@pane`), and `dori up` / `dori restart` print the mode as
`units=headless` instead of `units=panes`. The default, `true`, keeps pane mode; a supervisor that cannot reach the
runtime still logs one `panes_unavailable ... headless=1` line and keeps the headless children.

The pane command line is quoted for the pane's shell (PowerShell on Windows herdr, `sh` for hc). On herdr the unit is
the direct `bun` child of the pane's shell in the OS process tree, so `process-info`'s shell pid plus the parent links
identify it; when herdr reports a foreground command line, the unit's script and args are matched there first, and no
command-line scan is ever spawned. hc reads its terminal's foreground process and command line. The supervisor records
`name:pid@pane`; `dori status` prints it, and `dori restart` / `dori up` add the `UNITS` line naming any headless unit.

The supervisor never asks PowerShell for process status. A recorded pid is checked with `kernel32!OpenProcess` on
Windows, or `kill(pid, 0)` on POSIX, and the process tree is a Toolhelp32 snapshot on Windows (one hidden `ps` on POSIX).
The only `Get-CimInstance` left runs on an explicit lead restart, hidden, because the lead stack is identified by command
lines the kernel does not expose; a supervisor status read or a restart never spawns it.

Measured cost on this host (Windows 11, herdr 0.9.5, 2026-11-23, 8 empty unit panes): each PowerShell pane host is
~55 MB private / ~72 MB working set, and the herdr server grows ~2.6 MB private (terminal state) per pane. At 8 units
that is ~460 MB private / ~585 MB working set, far above the +10 MB/pane Linux budget; on a POSIX host with `sh` the
per-pane cost is a few MB plus the same terminal state. The unit process itself costs the same either way; pane mode adds
the shell.

The repo owns each program under `src/supervisors/`; `~/.dori/bin/*.ts` is a two-line shim into the installed checkout, so a
launcher or the watchdog keeps spawning the same path it always did.

## Loop budget

The hourly loop's caps come from `$DORI_HOME/config.json`: `maxLanes` (default 5) and `maxStarts` (default 2). When
either key is present the supervisor starts the loop unit with `--max-lanes <n> --max-starts <m>` (the missing key is
filled from the default); when neither is present the unit is started as plain `loop`, so its own defaults apply.
`dori up` passes the same flags to the hourly pane when the loops are not supervised. The loop's host guard is unchanged:
nothing starts while free memory is under 10% or the 1-minute load is above the core count, whatever the caps say.

## `dori status`

```
RUNTIME herdr (from config)
lead=w9:p1 duty=- home=C:\Users\USER\.dori
STALE <role>=<ref>: pane not found          # only when roles.json names a dead pane
SUPERVISED supervisor up pid=12836 hb=1s units=discord-gateway:4528@w9:p3,duty:18000@w9:p4,loop:19416@w9:p5,ensure-up:8368@w9:p6
WATCHDOG up pid=5204 hb=0s
PLUGIN ensure-up up pid=8368 hb=2s
PLUGIN update-check up pid=3140 hb=3s (next 04:00)
PLUGIN gateway-catchup up pid=9977 hb=4s
```

The supervisor is `up` only when its recorded pid is alive **and** its heartbeat is inside the 90 s window; the liveness
read is kernel32 `OpenProcess` on Windows, so a status command never opens a console window. The watchdog
line is separate: its own heartbeat and record, one stale threshold, one grace window. Plugin lines come from
`state/plugins/<name>.json` plus the child's own `.tick` beat; a disabled plugin leaves no line, and
`PLUGIN ensure-up ... (off)` means `state/ensure-up.off` is present. A role whose pane is gone is printed as `STALE`, and
`dori send <role>` refuses it instead of queueing text nowhere.

## `dori restart`

Kills the supervisor and every child its records name (`state/supervisor.json` units, `state/plugins/<name>.json` and
`state/ensure-up.json`), so a supervisor killed on its own does not leave orphans behind. A recorded pid is taken only
when it is alive and its OS start time matches the record, so a pid Windows reused for another process is left alone.
It starts one supervisor again and returns only when the supervisor
heartbeat, `gateway-ws-heartbeat` (the Discord socket actually acked) and the units — the three core children plus every
enabled plugin — are newer than the moment the restart began. `RESTART INCOMPLETE` (exit 1) means one of them did not
come back, and the lines above the verdict say which. An attempt that comes back short is retried once with the same
ensure step; when it fails again, each missing piece is printed as `RESTART MISSING <heartbeat|gateway-ws|unit|ensure-up>`
and the verdict carries `retried=1`.
A live watchdog is left alone; a missing one is started.

Measured on this host (Windows, herdr 0.9.5, 2026-11-16). These runs predate the plugin split: "five units" means the
three core children plus the two side-jobs that were units then; the plugin children are restart-checked the same way.

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

`ensure-up` is a plugin (`src/plugins/ensure-up.ts`) over the same engine in `src/supervisors/ensure-up.ts`. The
supervisor starts its child while `state/plugins.json` enables it; the plugin idles and reports `off` while
`state/ensure-up.off` exists. Every 20 s the loop probes the pane `roles.json` registers as `lead`; only when that role
is missing or its pane is `gone` does it run `dori up`. A probe that fails is doubt and raises nothing. One loop per home
is enforced by `state/ensure-up.lock` (a dead holder's lock is taken over), so two supervisors cannot raise two
workspaces. A pane-mode `dori up` (loops not supervised) starts the same plugin child itself.

Because the decision is the lead's own pane, a `dori up` that finds a live lead opens no second workspace: it ensures
the supervised units and prints one line, and only `dori up --retire-old true` opens a fresh lead and closes the old one.

## Roles under supervision

The duty and hourly loops are supervisor children; on a runtime they are shown in the `dori-ops` panes described above,
which is why a `dori up` that opens panes under a live supervisor opens only the lead and duty panes and drops
`duty-loop` / `hourly-loop` from `roles.json`; a stale role left by an older layout is removed with `dori role <role> -` (clearing accepts the loop
roles; registering still accepts only lead and duty).

## What the merge removed

`gateway-supervisor.ts` and `loops-supervisor.ts` no longer exist. `state/loops-heartbeat`, `state/gateway-supervisor.json`
and `state/loops-supervisor.json` are neither read nor written; `state/gateway-heartbeat` stays as the compatibility
write for the Windows boot guard, and `gateway.log` / `loops.log` remain the child-output logs of headless units (pane
units log to their pane). `dori restart` reads records now, not command lines, so a host still running the pre-merge
pair must have those old processes stopped once by hand (or by the boot guard) before the merged supervisor takes the slot.

## Tests on Windows

`bun test ./test/` is green here except for guards that name win32 and why:

- `install.test.ts`: `install.sh` is a POSIX shell installer run through bash; the POSIX CI jobs cover it.
- `shq.test.ts`: the subject is the single-quote form a POSIX `sh` reads; Windows has no `sh`.
- `runtime-select.test.ts` ("non-executable file named hc"): Windows has no executable bit, so `accessSync(X_OK)` passes
  for any file on PATH.
- `e2e.test.ts`: the fake agent is a POSIX shell fixture that a Windows herdr pane cannot execute; the Linux/macOS CI
  jobs run the real-herdr end-to-end.
- `gate.test.ts` checks the private 0600 diagnostic only on POSIX; `statSync` synthesizes 0o666 on Windows.
