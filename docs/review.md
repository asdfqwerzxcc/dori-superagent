# Review: lane receipt, lane PR, merge gate

Dori reviews lane work locally first. The record of a review is a receipt file under `$DORI_HOME/receipts/`. Once that
lane receipt is CLEAR, `dori merge <key>` is the landing path: it pushes `lane/<key>`, opens or updates the PR, gates on
the PR checks, merges with a merge commit, and deletes the remote branch. The review step itself still creates no git
branch, no push, and no PR; the landing step does.

## The three layers

| Layer | Who runs it | Evidence |
| --- | --- | --- |
| Lane review | `dori review --lane <key>` queues a fresh, non-interactive reviewer on the lane's own commits for `dori duty` | `receipts/lane_<key>@<tip>.json` |
| Lead review | the lead reads the lane's final answer and its evidence (`dori ready`) and may read the receipt or diff | the lane's `final` entry and `lane-reviews/lane_<key>@<tip>.diff` |
| Lane merge gate | `dori merge <key>` after a CLEAR lane receipt: push, PR create/update, checks, merge commit, remote-branch delete | the lane receipt plus the PR checks (`checks=none` when the repo has no workflows) |

The lane receipt is written locally; `dori merge <key>` is the landing path that pushes the branch and opens the PR. A
lane that committed nothing closes without a receipt and without a PR.

## Layer 1: the lane review

`dori start` records the main checkout as the landing target and its current commit as the lane's immutable base
(`baseSha`), creates the lane's own worktree at `$DORI_HOME/worktrees/<key>` on branch `lane/<key>`, locks it, and opens
the lane's pane there. The lane commits and the reviewer reads that worktree; `laneRepo` resolves to it. A lane started
from a directory that is not a repository uses the harness checkout `$DORI_HOME/src` as its main checkout, as before.
The lane record also carries the current `tipSha`, refreshed at each review.

`dori review --lane <key> [--model M]` then:

1. takes the merge-base of the recorded base and the current tip in the lane's worktree, so a moved branch still reviews
   only the lane's work;
2. refreshes the tip and diffs exactly `base..tip`;
3. saves the full diff to `lane-reviews/lane_<key>@<tip>.diff` and renders `prompts/review-lane.md` with the brief path, the
   base, the tip, that diff and the worktree as `repo`; a diff over 16 KB or 200 changed lines is split by path into
   chunks (`lane-reviews/lane_<key>@<tip>.chunk-<n>.diff`), each rendered with `prompts/review-lane-chunk.md` and
   reviewed in sequence; a chunk that exits zero with an empty answer is split once more, by path (or by hunks when
   one file remains), and its sub-chunks are reviewed before the review is called empty;
4. runs the reviewer non-interactively (`omo -p --no-session --model M`, or `hooks.reviewCommand` when configured) with a
   30-minute chunk window (`DORI_REVIEW_TIMEOUT_MS` overrides it) inside a 60-minute job budget
   (`DORI_REVIEW_BUDGET_MS` overrides it). Each chunk gets the smaller of the window and the budget left; the primary
   and the fallback each get at most half the window (15 minutes), so a stalled primary cannot consume the fallback's
   turn before the window closes. When the budget runs out, the chunks not attempted are recorded as `not run` and a
   retry resumes them. Output streams to `state/reviews/<key>.log` with one "still running" line every 30 s; a failed
   attempt (timeout, non-zero exit, empty stdout or no verdict) is retried once with `reviewFallbackModel` from
   `config.json` when that key is set and differs from the first model. An attempt that fails without a verdict is
   retried on the fallback at once; only a clean exit-zero empty answer is re-split first. A non-zero exit before any
   output whose stderr names a missing or rejected key, or a process that cannot be started, marks the primary down for
   the rest of the job: later chunks go straight to the fallback instead of repeating the same failure;
5. reads exactly one final `VERDICT: CLEAR|BLOCK` line per chunk, continues with the remaining chunks after one fails,
   and writes `receipts/lane_<key>@<tip>.json` with the verdict, base, tip, brief path, reviewer command (including its
   `--model`, and the fallback when one ran), time and, for a chunked review, a `chunks` array naming every chunk's
   paths, bytes, changed lines, state, model, duration, whether it was reused from an earlier attempt and whether the
   primary was down (`primaryDown: true`).

A `hooks.reviewCommand` reviewer still gets the deadline, the log, the diagnostic and the failure receipts, but it runs
once on the full diff and is not retried with a fallback model: it owns its own command, so the path chunking and
`reviewFallbackModel` apply to the built-in `omo` reviewer.

The receipt names the exact tip, so it can never describe a different diff. A new commit after a review invalidates it:
review again.

A chunked review writes its receipt before the first reviewer starts: verdict `review_partial`, every planned chunk
marked `pending`, then rewritten after each chunk (`running`, then `CLEAR`, `BLOCK`, `timed out`, `empty`, `failed` or
`not run`). The receipt is therefore never missing while a large review is in flight, and a killed worker leaves its
last progress behind. `dori done` refuses `review_partial` like every other non-CLEAR verdict.

A job never downgrades a completed verdict. The decision is made against the canonical receipt on disk at write time
under a per-lane+tip lock, not a snapshot from job start: while a tip already has CLEAR or BLOCK, progress goes to
`state/reviews/<key>@<tip>.progress.json` instead of the canonical receipt, and a job that ends in failure writes its
failure to that sidecar (plus its diagnostic) rather than replacing the CLEAR/BLOCK. BLOCK wins at the same tip: a
later CLEAR never replaces a BLOCK (it goes to the sidecar/history), and a lane clears a BLOCK only by moving the tip.
A job that produces a stronger verdict may replace the canonical one. The write-time re-read remains defence in
depth: a newer `writerAt` already on disk sends the result to the sidecar only. A live owner is never preempted, so a
holder cannot resume after a fence and overwrite the newer answer.

The receipt read-modify-write is serialized per lane and tip by a directory lock at
`state/reviews/<key>@<tip>.receipt.lock`. Acquisition creates `lock.new.<token>` with `owner.json`
`{token, pid, acquiredAt}` first, then renames it to the lock directory; the rename is atomic and a lock directory can
never exist without its owner record (except a legacy/corrupt bare directory). A release renames the lock to a
tombstone and removes it only when `owner.json` still carries its token. A waiter never preempts a live pid, no matter
how old the record is: it checks the owner with `kill(pid, 0)`; ESRCH means the owner is dead and the waiter takes the
lock over immediately (rename to a tombstone, retry), while EPERM or success means alive and the waiter gives up after
15 s with `held by live pid N since T` and writes no receipt. A bare directory without `owner.json` is legacy/corrupt
and is taken over only after the 10 s TTL. Every canonical receipt carries `writerAt` = the writer's `acquiredAt`.
`savePartialReceipt`, `saveFinalReceipt` and the sidecar clear all run under this lock; the clear is fenced by the
caller's `writerAt`, so a stale older caller cannot delete a newer sidecar. A live but hung owner keeps the lock: the
fail-closed outcome is the held-by-live-pid report, and duty can kill that process.

A failed chunk no longer ends the job: the remaining chunks are still reviewed, so one timed-out chunk cannot hide
what the other chunks said. A reviewer whose process cannot be started at all (the exec throws, for example a missing
agent binary) is that chunk's `failed` result with the error text; later chunks are still attempted and the final
receipt names it. The final verdict is `BLOCK` when any chunk blocked, even if another chunk timed out or the budget
ran out; otherwise `reviewer_timeout` when a chunk timed out or the budget ran out, `reviewer_empty` when a chunk
printed nothing, `review_partial` when a chunk failed without one of those verdicts, otherwise `CLEAR`. The summary and
the `chunks` field carry every chunk's state and each failure's diagnostic.

Chunks that answered are checkpointed in `state/reviews/<key>@<tip>.chunks.json`, keyed by the rendered chunk prompt and
by the reviewer command. A retry at the same tip reuses only the chunks that answered `CLEAR` or `BLOCK`; a chunk that
exited non-zero, printed no verdict, threw, timed out or was never run is attempted again. A re-split parent is
attempted again even when its sub-chunks are reused: the parent's empty answer is what triggers the re-split, and the
sub-chunks that already answered are read from the checkpoint. The checkpoint is deleted when the review finishes
`CLEAR` or `BLOCK`, and one written for another tip or another `--model` is ignored.

A reviewer that outlives the deadline is killed and writes a receipt whose verdict is `reviewer_timeout`, carrying the
partial stdout, the stderr and the exit code (when the killed process reported one), plus every chunk's state. When the
tip already has a CLEAR/BLOCK, that failure goes to the sidecar instead and the completed verdict stays. A reviewer
that exits zero with an empty stdout on a chunk is first re-split; a non-zero exit or a thrown run is an immediate
failure and goes to the fallback first, without a re-split. Only a sub-chunk that is still empty (or a single chunk
that cannot be split) writes a `reviewer_empty` receipt, also carrying stderr and the exit code. Both are failed reviews:
`dori done` refuses them and never treats the lane as approved. The full output stays in
`state/reviews/<key>.log`.

A failed run also writes one JSON diagnostic, `receipts/lane_<key>@<tip>-<uuid>.diagnostic.json` (mode 0600), with
`exitCode`, `durationMs`, `stdoutTail`, `stderrTail`, `argv` (the prompt elided, or `null` when the reviewer could
not be started at all), `model` and `cause` (one line, e.g. `exit 1: No API key found for opencode.`); a chunked review
adds `chunk`. The failed attempt that starts a fallback retry carries `retried: true` and `retryModel`; a failed retry
carries `retried: true` with its own model, so the diagnostic pair names both attempts. The same compact JSON is in the
refusal line. That
is what turns a zero-byte answer into a diagnosis: the exit code, the duration, the stderr and the argv (including the
model) are all on disk.

A reviewer that prints its `VERDICT:` line and then fails to exit is done answering: the CLI reads for a short grace
(2 s), kills the process, accepts the verdict, and says `verdict printed; killed after ...` in the receipt. Only a process
that reaches the deadline without a verdict writes `reviewer_timeout`.

A reviewer that printed something but no `VERDICT` line writes no receipt on a single-diff review; the diagnostic
above is its record and the command fails. A reviewer whose process cannot be started at all writes a `review_partial`
receipt on a single-diff review (and a `failed` chunk on a chunked one), with the thrown message in the summary and the
diagnostic. A chunked review always leaves a receipt (the pending `review_partial`, then the final verdict) and its
`chunks` array records the chunk that failed. A zero-byte answer is always `reviewer_empty`, never a pending review. A
verdict printed only to stderr is not accepted: it is a `reviewer_empty` receipt whose diagnostic keeps that stderr.

### Why a chunk can take ten minutes

A measurement of the 24 reviewer diagnostics under `$DORI_HOME/receipts/` (2026-11-16..22) found 11 at the old 600 s
deadline (+0.3 s kill). The timed-out chunks were 5,085 B/105 lines, 6,656 B/84, 11,650 B/120, 14,786 B/170,
16,156 B/188, 16,330 B/199 and 39,605 B/706; three of the seven chunked timeouts were under 12 KiB, and four
non-chunked runs on 4.1-7.0 KiB diffs hit the same 600 s. The same 43,936 B/809-line chunk cleared on a rerun, and a
6-chunk 56 KiB lane finished with per-chunk answers between 78 s and 600 s. The deadline was not catching oversized
chunks; it was cutting off a slow provider mid-answer.

The response is the per-attempt deadline *plus* the job budget, continuing after a failed chunk, a receipt from the
moment the plan exists, and checkpointed reuse. A chunk's primary and fallback each get half the window, so a stalled
primary leaves the fallback a turn instead of eating the whole 30 minutes. Lowering the chunk cap would multiply calls
and hang exposure without removing the failure; one read-only reviewer for the whole diff has a single deadline and no
per-chunk progress, and the successful single-review runs observed here took 8-17 minutes, already past 600 s. Applied
to the 56 KiB `ui-baseui` lane at `3e6b633`, the new path had a `review_partial` receipt 0.5 s after the run started
(before any reviewer output) and recorded its first 5 KiB chunk CLEAR at 495 s, well inside the old 600 s horizon.

### The queued path

When a duty loop runs in the same home, `dori review --lane <key> [--model M]` reviews nothing in the caller's pane. It
resolves the lane's current tip and merge-base, writes one job record and prints:

```
QUEUED <key> <tip> <job>
```

The caller returns at once, the receipt is written and readable while the duty worker reviews, and the job is bounded
by `DORI_REVIEW_BUDGET_MS`; a caller that has a duty loop never waits for the reviewer's deadline.

A request for the same lane and tip while that job is still in flight prints `already queued <job> (<state>)` and
returns without starting a second reviewer; `<state>` is `queued` until a worker picks it up and `running` from then
on. `--restart` is the only way to replace an in-flight job: it kills the reviewer process tree that job started,
queues a fresh job and prints `QUEUED <key> <tip> <job> (restarted)`.

The record is `$DORI_HOME/state/review-queue/<key>@<tip>.json`, written atomically, holding `lane`, `tip`, `base`,
`model` (when one was given), `requestedAt` and `state`. The record is never rewritten while queued; the live half of
the job is the sibling `<key>@<tip>.running`, holding `requestedAt`, the reviewer's `pid`, the `host` that started it
and its OS `startTime`, which is how another process finds the tree to kill and how `dori done` knows the job is
running. A pid is never permission by itself: before any kill the marker must name this host and the same process
start time, so a marker left through a reboot (or copied in from another host) whose pid Windows has reused drops the
marker without touching that process. A record that cannot be read as a valid job (bad bytes or bad fields) is
dropped by the next duty pass instead of blocking the queue; until then `dori done` refuses that lane and tip as in
flight but unreadable and says to queue it again. The queue trusts the duty lock for liveness, so a worker that is
alive but hung keeps a job waiting until it recovers or is replaced.

Every reviewer is spawned as its own process group (`taskkill /T` walks the tree on Windows): a timeout, a printed
verdict followed by a hang, `--restart`, or a lane dropped while its review runs kills the whole tree, so a provider
child cannot outlive the shim it was started from. A kill that cannot land is reported and keeps its marker; the
drain keeps that job and retries it next pass, and `--restart` refuses rather than start a second reviewer beside one
it could not stop. A failed kill is fatal for the attempt, not a failed answer: no fallback model and no next chunk
is started, because each spawn would overwrite the one marker that still names the live reviewer. It also outranks a
BLOCK another chunk already reported: the receipt is `reviewer_timeout`, never BLOCK, so the job stays queued. The
progress line and the `reviewer_timeout` receipt name the kill failure, and the next pass retries. A worker that dies
mid-review leaves its job `running`; the next duty pass kills the reviewer tree it left and runs the job again. A
finished drain deletes the job record only while it still carries the drain's own `requestedAt`, so a restart that
wrote a new record at the same path is never erased by the old run.

`dori duty` drains the queue at the end of each pass: it runs the same reviewer as the inline path (same prompts,
chunking, deadline, log, diagnostics and receipt), drops the job, and sends the lead one inbox message:

```
[REVIEW <key>] CLEAR at <tip>; receipt <home>/receipts/lane_<key>@<tip>.json
```

A review that fails or times out posts the same way, naming the failure instead of a verdict
(`[REVIEW <key>] failed at <tip>: <reason>`). `dori done` never waits on a queued review: while a job for the lane's
current tip is pending it refuses, saying the review is in flight and that the verdict will arrive as an inbox message.
Once the receipt exists, land with `dori merge <key>`; `dori done` closes the lane after the PR lands.

With no duty loop running (a plain install, or a worker that died), `dori review --lane` reviews inline exactly as
before; that inline run first kills the reviewer tree a dead worker's verified marker names, and refuses rather than
start a second reviewer when that kill cannot land.

## Layer 2: the lead review

A lane reports `dori ready <key> --text ... --evidence ...`; the final answer and its evidence are what the lead judges.
The receipt from layer 1 answers "did a fresh reviewer see this exact diff and clear it", not "is the work right"; the
lead still reads the answer, the evidence and, when it matters, the diff.

## Layer 3: the lane merge gate

`dori merge <key>` checks the CLEAR lane receipt at HEAD, pushes `lane/<key>` to the lane repo's own remote (fork when
present, else origin; an upstream is refused), creates or updates the PR against `main`, refuses while PR checks are
pending or failed, merges with a merge commit, and deletes the remote branch. A repository with no configured workflows
records `checks=none` and is not refused. The `dori merge <owner/repo#N>` form remains for non-lane PRs.

## `dori done`: close and clean up after the PR lands

`dori done <key>` is the close path, not the landing path; `dori merge <key>` lands the PR. `done` refuses to close a
lane whose current tip has no CLEAR receipt (or whose receipt is a failed review), exactly as before:

```
lane <key> at <sha> has no review receipt; run: dori review --lane <key> (or dori done --drop <key> --reason <text>)
```

A failed review at that tip refuses the same way, naming the verdict and the log:

```
lane <key> at <sha> is reviewer_timeout; log: <home>/state/reviews/<key>.log; run: dori review --lane <key> (or dori done --drop <key> --reason <text>)
```

A review still in the queue refuses without waiting and without sending the lead to review it again:

```
lane <key> at <sha>: a review is in flight (<state>, requested <time>); its verdict will arrive as an inbox message from duty. Run dori done <key> again once the receipt exists (or dori done --drop <key> --reason <text>)
```

These verdicts (and `reviewer_empty` and `review_partial`) are failures, not passes: the lane is never approved by a
review that produced no answer. A lane that committed nothing (`base` equals `tip`) closes without a receipt: an
investigation lane has no diff to review. A lane started before this gate has no recorded base; it closes with an explicit `(no review gate: ...)` note
instead of being reviewed against a guessed base. There is no force path: a BLOCK, a failed review or a missing receipt
is resolved by reviewing again, or by `dori done --drop <key> --reason <text>`, which closes the lane, removes its
worktree and branch without landing, records `dropped` with the reason, and never touches `main`. The escape hatch is
explicit, never silent.

## `dori status`

Each lane row ends with `review=reviewed`, `review=<verdict>` (for example `review=BLOCK`, `review=reviewer_timeout`)
or `review=no receipt`, read from the receipt pinned to the lane's current tip. `reviewed` means a CLEAR receipt exists at
that tip; any other verdict means that receipt refused the tip; `no receipt` means neither (including a lane from before
the gate).

## Limits

Each lane commits in its own worktree on branch `lane/<key>`, so `base..tip` is the lane's own history: another lane
cannot add to it, and a lane cannot dirty the main checkout. `dori done` checks the tree is clean, closes the pane,
verifies `main` already contains the lane branch from the PR merge (or fast-forwards it as a legacy local fallback when
`main` still sits at the recorded base), then removes the worktree and the local branch. If `main` moved without the
lane, `done` refuses with `main moved: rebase required` and keeps both; `dori done --drop <key> --reason <text>` removes
them without landing a PR. A LOST lane keeps its tree and branch for inspection and refuses a restart until it is dropped.
`dori worktrees list` names every lane tree with its lane status and orphan reason, `dori worktrees prune` removes
orphan trees and their branches (naming a dirty tree and leaving it, never forcing), and `dori status` adds one
`WORKTREES <n> orphan` line when any exist. Receipts and diffs are per lane key and per tip commit, so they never
collide.
