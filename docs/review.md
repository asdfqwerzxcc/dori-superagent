# Review: three layers, no pull request, no push

Dori reviews lane work locally. Nothing in this flow contacts a remote: no branch is created, nothing is pushed, and no
pull request is opened. The record of a review is a receipt file under `$DORI_HOME/receipts/`.

## The three layers

| Layer | Who runs it | Evidence |
| --- | --- | --- |
| Lane review | `dori review --lane <key>` queues a fresh, non-interactive reviewer on the lane's own commits for `dori duty` | `receipts/lane_<key>@<tip>.json` |
| Lead review | the lead reads the lane's final answer and its evidence (`dori ready`) and may read the receipt or diff | the lane's `final` entry and `lane-reviews/lane_<key>@<tip>.diff` |
| Merge gate | `dori merge <owner/repo#N>`, only when the work exists as a PR | `receipts/<owner__repo>_<N>@<sha>.json` plus green checks |

The first two layers always apply to a lane. The merge gate is the PR path: it is unchanged and it is skipped entirely
when no PR exists. A local commit is approved by layers 1 and 2; it is never merged through `dori merge`.

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
   reviewed in sequence; a chunk that returns an empty answer is split once more, by path (or by hunks when one file
   remains), and its sub-chunks are reviewed before the review is called empty;
4. runs the reviewer non-interactively (`omo -p --no-session --model M`, or `hooks.reviewCommand` when configured) with a
   10-minute deadline per attempt (`DORI_REVIEW_TIMEOUT_MS` overrides it), streams its stdout/stderr to
   `state/reviews/<key>.log`, and prints one "still running" line every 30 s; a failed attempt (timeout, non-zero exit,
   empty stdout or no verdict) is retried once with `reviewFallbackModel` from `config.json` when that key is set and
   differs from the first model;
5. reads exactly one final `VERDICT: CLEAR|BLOCK` line per chunk (BLOCK wins when any chunk blocks) and writes
   `receipts/lane_<key>@<tip>.json` with the verdict, base, tip, brief path, reviewer command (including its `--model`,
   and the fallback when one ran), time and, for a chunked review, a summary naming every chunk, its model and its
   result.

A `hooks.reviewCommand` reviewer still gets the deadline, the log, the diagnostic and the failure receipts, but it runs
once on the full diff and is not retried with a fallback model: it owns its own command, so the path chunking and
`reviewFallbackModel` apply to the built-in `omo` reviewer.

The receipt names the exact tip, so it can never describe a different diff. A new commit after a review invalidates it:
review again.

A reviewer that outlives the deadline is killed and writes a receipt whose verdict is `reviewer_timeout`, carrying the
partial stdout, the stderr and the exit code (when the killed process reported one). A reviewer that exits with an empty
stdout on a chunk is first re-split; only a sub-chunk that is still empty (or a single chunk that cannot be split) writes
a `reviewer_empty` receipt, also carrying stderr and the exit code. Both are failed reviews: `dori done` refuses them and
never treats the lane as approved. The full output stays in `state/reviews/<key>.log`.

A failed run also writes one JSON diagnostic, `receipts/lane_<key>@<tip>-<uuid>.diagnostic.json` (mode 0600), with
`exitCode`, `durationMs`, `stdoutTail`, `stderrTail`, `argv` (the prompt elided) and `model`; a chunked review adds
`chunk`. The same compact JSON is in the refusal line. That is what turns a zero-byte answer into a diagnosis: the exit
code, the duration, the stderr and the argv (including the model) are all on disk.

A reviewer that prints its `VERDICT:` line and then fails to exit is done answering: the CLI reads for a short grace
(2 s), kills the process, accepts the verdict, and says `verdict printed; killed after ...` in the receipt. Only a process
that reaches the deadline without a verdict writes `reviewer_timeout`.

A reviewer that printed something but no `VERDICT` line writes no receipt; the diagnostic above is its record and the
command fails. A zero-byte answer is always `reviewer_empty`, never a pending review. A verdict printed only to stderr is
not accepted: it is a `reviewer_empty` receipt whose diagnostic keeps that stderr.

### The queued path

When a duty loop runs in the same home, `dori review --lane <key> [--model M]` reviews nothing in the caller's pane. It
resolves the lane's current tip and merge-base, writes one job record and prints:

```
QUEUED <key> <tip> <job>
```

The record is `$DORI_HOME/state/review-queue/<key>@<tip>.json`, written atomically, holding `lane`, `tip`, `base`,
`model` (when one was given), `requestedAt` and `state` (`queued`, then `running` while a worker has it). A second
request for the same lane and tip returns that record instead of starting a second reviewer. A record that cannot be
read as a valid job (bad bytes or bad fields) is dropped by the next duty pass instead of blocking the queue; until
then `dori done` refuses that lane and tip as in flight but unreadable and says to queue it again. The queue trusts
the duty lock for liveness, so a worker that is alive but hung keeps a job waiting until it recovers or is replaced.

`dori duty` drains the queue at the end of each pass: it runs the same reviewer as the inline path (same prompts,
chunking, deadline, log, diagnostics and receipt), drops the job, and sends the lead one inbox message:

```
[REVIEW <key>] CLEAR at <tip>; receipt <home>/receipts/lane_<key>@<tip>.json
```

A review that fails or times out posts the same way, naming the failure instead of a verdict
(`[REVIEW <key>] failed at <tip>: <reason>`). `dori done` never waits on a queued review: while a job for the lane's
current tip is pending it refuses, saying the review is in flight and that the verdict will arrive as an inbox message,
and the same `dori done` lands once the receipt exists.

With no duty loop running (a plain install, or a worker that died), `dori review --lane` reviews inline exactly as
before; that inline run also drops a job record a dead worker left for the same lane and tip. A worker that dies
mid-review leaves its job `running`, and the next duty pass runs it again.

## Layer 2: the lead review

A lane reports `dori ready <key> --text ... --evidence ...`; the final answer and its evidence are what the lead judges.
The receipt from layer 1 answers "did a fresh reviewer see this exact diff and clear it", not "is the work right"; the
lead still reads the answer, the evidence and, when it matters, the diff.

## Layer 3: the merge gate (PR only)

`dori merge` keeps its existing rule: a CLEAR receipt at the exact PR head plus at least one passing check, with an empty
check list never green. This layer never runs for local-only work, and nothing in the lane flow pushes or opens a PR.

## `dori done` and the escape hatch

`dori done <key>` refuses to close a lane whose current tip has no CLEAR receipt. The refusal is one line naming the
command to run:

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

These verdicts (and `reviewer_empty`) are failures, not passes: the lane is never approved by a review that produced no
answer. A lane that committed nothing (`base` equals `tip`) closes without a receipt: an investigation lane has no diff to
review. A lane started before this gate has no recorded base; it closes with an explicit `(no review gate: ...)` note
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
fast-forwards `main` when it still sits at the recorded base, then removes the worktree and the branch. If `main` moved,
`done` refuses with `main moved: rebase required` and keeps both; `dori done --drop <key> --reason <text>` removes them
without landing. A LOST lane keeps its tree and branch for inspection and refuses a restart until it is dropped.
`dori worktrees list` names every lane tree with its lane status and orphan reason, `dori worktrees prune` removes
orphan trees and their branches (naming a dirty tree and leaving it, never forcing), and `dori status` adds one
`WORKTREES <n> orphan` line when any exist. Receipts and diffs are per lane key and per tip commit, so they never
collide.
