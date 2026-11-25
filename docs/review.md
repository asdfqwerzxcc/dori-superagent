# Review: lane request, reviewer session, lane receipt

Dori reviews lane work locally first. `dori review --lane <key>` records the lane's current tip and diff and prints
`QUEUED`. The review itself runs in its own session: `dori review <owner/repo#N> --background` opens that session,
returns at once, and the worker records a PR receipt; its verdict is recorded as the lane receipt with `dori review
<key> --attest ...`. The foreground `dori review <owner/repo#N>` still runs one reviewer in the caller's process for a
manual check. Both paths stop at the review ceiling (2 hours or 250000 tokens, whichever comes first; the constants live
in `src/worker-limits.ts`): at the ceiling the reviewer stops at a safe point, lists what stayed unverified, and prints
`VERDICT: BLOCK` when that could hide a HIGH or MEDIUM finding. The lane receipt schema is additive: `patchId` is
optional, and older receipts need no migration. Once the lane receipt is CLEAR, `dori merge <key>` is the landing path.

Why: reviews must not run as children of the lead pane. A gate-review child keeps the lead `working`, holds its inbox
and puts review work in the human's session (Lee, 2026-11-24). A separate reviewer session keeps the lead free for
inbound. The number of concurrent reviews is limited by free memory alone (one reviewer holds 300-500 MB), never by a
clock; when free memory is below the floor every agent shares, a new review is refused with the numbers.

## The three layers

| Layer | Who runs it | Evidence |
| --- | --- | --- |
| Lane review | `dori review --lane <key>` records a request; `dori review <owner/repo#N> --background` reviews the PR in its own session, and its verdict is attested with `dori review <key> --attest` | `receipts/lane_<key>@<tip>.json`; the PR receipt under `receipts/`; `state/reviews/jobs/<job>.json` |
| Lead review | the lead reads the lane's final answer and its evidence (`dori ready`) and may read the receipt or diff | the lane's `final` entry and `lane-reviews/lane_<key>@<tip>.diff` |
| Lane merge gate | `dori merge <key>` after a CLEAR lane receipt: push, PR create/update, checks, merge commit, remote-branch delete | the lane receipt plus the PR checks (`checks=none` when the repo has no workflows) |

The lane receipt is written locally; `dori merge <key>` is the landing path that pushes the branch and opens the PR. A
lane that committed nothing closes without a receipt and without a PR.

## Layer 1: the lane review

`dori start` records the main checkout as the landing target and its current commit as the lane's immutable base
(`baseSha`), creates the lane's own worktree at `$DORI_HOME/worktrees/<key>` on branch `lane/<key>`, locks it, and opens
the lane's pane there. The lane commits and the reviewer reads that worktree; `laneRepo` resolves to it. A lane started
from a directory that is not a repository uses the harness checkout `$DORI_HOME/src` as its main checkout, as before.

`dori review --lane <key> [--model M] [--restart] [--legacy-kill]` then:

1. takes the merge-base of the recorded base and the current tip in the lane's worktree, so a moved branch still reviews
   only the lane's work;
2. refreshes the tip and saves the full diff to `lane-reviews/lane_<key>@<tip>.diff`; there is no chunking: the reviewer
   session receives the whole PR diff and the saved lane diff is evidence for the attestation;
3. writes one request record and prints `QUEUED <key> <tip> <job>`; it returns at once and spawns nothing. `--model M`
   is recorded on the request for the lead's reference; the queue never runs it.

A request for the same lane and tip while one is queued prints `already queued <job> (queued)` and returns without
adding a second record. `--restart` replaces the request (a new `requestedAt`) and prints `QUEUED ... (restarted)`.
Queueing a new tip for a lane removes that lane's older-tip request, and the drain detail names the tip.
The request record is `$DORI_HOME/state/review-queue/<key>@<tip>.json`, written atomically, holding `lane`, `tip`,
`base`, `model` (when one was given), `requestedAt` and `state`. It stays `queued` until a receipt is recorded or the
lead replaces it with `--restart`; nothing expires it for its age.

### The reviewer session

The review runs in its own session, never as a `task`/subagent child of the lead pane. `dori review <owner/repo#N>
--background` opens a tab in the lead's workspace, starts the worker there, prints `REVIEW_STARTED ...` and returns.
The worker fetches the PR head and diff, renders `prompts/review.md`, starts one fresh non-interactive reviewer
(`omo -p`, or the configured `reviewCommand` hook), and records its answer as a PR receipt. Give it the lane brief as
context; the PR head must equal the lane tip. The reviewer contract is the same one the gate has always used: check the
change against the lane's goal for correctness, regressions, missing tests, security issues and scope creep; list
findings by severity (HIGH/MEDIUM/LOW); print exactly one final `VERDICT: CLEAR` (no HIGH or MEDIUM) or `VERDICT: BLOCK`
(at least one HIGH or MEDIUM); do not modify files. A numbered requirement (`rN`) with no change or evidence behind it is
HIGH unless the lane marked it `handed-off` with the recipient. A CLEAR verdict may carry LOW notes — the
`CLEAR/NOTES` report outcome — while the merge gate reads only CLEAR/BLOCK, so a note never blocks and a HIGH or MEDIUM
finding never clears.

`state/reviews/jobs/<job>.json` holds the job (`starting`, `running`, `done`, `failed`), the worker pid and start time,
the last output line, the bytes captured, the heartbeat and the verdict or failure; the tab is recorded separately in
`<job>.session`, so the start cannot overwrite the worker's first row. The worker rewrites the row every 30 seconds and
on every output burst; `state/reviews/<job>.log` keeps the full output and is created `0600`. `dori review --list`
prints the active rows and `dori status` adds one `REVIEW ...` line per active job. A second `--background` for the same
PR while its job is live prints `REVIEW_RUNNING ...` and starts nothing.

A start is a bounded handshake, not a review deadline: a start that never writes its running row within 60 seconds is
marked failed and its tab closed; `--background --restart` replaces only such a stuck start (a running review is
refused). The once-only slow and done notices use exclusive `<job>.slow`/`<job>.announced` markers, and terminal job
rows/logs are pruned (20 kept, 7 days; running rows are preserved). The full reviewer output is saved to
`receipts/<pr>@<sha>.review.txt` with a 64KB cap, and the receipt summary keeps the first and last 2000 characters, so
a HIGH at the top of a long transcript is not lost.

There is no review deadline in the harness: duty never kills, shortens or fails a review for its age, and a hook or a
reviewer that ignores the ceiling is left running. The reviewer itself stops at the review ceiling (2 hours or 250000
tokens, whichever comes first) and a partial review is never CLEAR. A review that passes two hours is reported to the
lead once with its last output line and the log path. A dead worker is checked against the sha recorded before the
reviewer ran: if the receipt exists the job is done, and only a dead worker without that receipt fails (once, with the
log path). A pid whose start time cannot be read is unknown, not dead; a record from another host is skipped. Free
memory, not a clock, decides admission: one reviewer needs about 500 MB, and a start is refused while `memFreePct < 10`
or `memFreeMb < 700`, or while the number of live reviews already equals `memFreeMb / 500`.

The lead records the answer as the lane receipt:

```
dori review <key> --attest --verdict CLEAR|BLOCK --reviewer <name> --evidence <report> [--evidence ...] [--summary <text>]
```

`--evidence` is required: name the report, task id, path or URL the verdict rested on. The receipt carries the verdict,
base, tip, brief path, reviewer name, time, summary and the evidence links, plus the `git patch-id --stable` of
`base..tip` when git can compute one. The gate takes the receipt at the exact tip first; with no receipt there, it
compares the current patch-id with the ids on disk. A new commit with different content invalidates the receipt and the
lead reviews again, while a rebase that leaves the patch unchanged keeps it valid (and `dori done --rebase` no longer
forces a re-review for a clean rebase). `BLOCK` wins for one patch: a later CLEAR attest never replaces a BLOCK on
disk, and moving only the SHA does not clear it; a lane clears a BLOCK by changing the patch.

### What duty does

`dori duty` drains both review records at the end of each pass. For a lane request it reports `review-queued` with the
state and age; a request has no deadline and is never expired (`--restart` replaces it; `dori done --drop` removes it).
For a background review it reports `review-starting`/`review-running` with the last output line, `review-slow` once
past two hours, and `review-done`/`review-failed` when the receipt or failure lands. It never spawns a reviewer, runs
`omo -p`, fans out a session, splits a diff, writes a partial receipt, kills a reviewer for its age, or measures one
against a deadline. A request that cannot be read as a valid job is dropped so it cannot wedge the queue.

`dori done` never waits on a queued request: while a fresh request exists for the lane's current tip it refuses, naming
the attestation command. Once the receipt exists, `dori merge <key>` lands the lane. `dori status` shows
`review=queued` while the request waits.

The default path never kills a process for its age. `--legacy-kill` (or `DORI_REVIEW_LEGACY_KILL=1`) is the explicit
cleanup path for a reviewer tree an older dori recorded: `--restart --legacy-kill` proves the recorded pid by host and
OS start time, kills that tree, and refuses to replace the request when the kill fails. Without the flag, `--restart`
only replaces the record. `dori done --drop` honors `DORI_REVIEW_LEGACY_KILL=1` when it removes a lane's queued
requests.

The PR review path (`dori review <owner/repo#N>`, `--background` for the non-blocking form, and its `--attest` form) is
the reviewer-session path; it is also how a lane review runs now.

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
lane whose current tip has no CLEAR receipt (or whose receipt is a failed review):

```
lane <key> at <sha> has no review receipt; run: dori review --lane <key> to queue it, then record the reviewer verdict with dori review <key> --attest ... (or dori done --drop <key> --reason <text>)
```

A review request still queued at that tip refuses without waiting and names the attestation:

```
lane <key> at <sha>: a review request is queued (queued, requested <time>); run the review in its own session with dori review <owner/repo#N> --background, then record the verdict with dori review <key> --attest --verdict CLEAR|BLOCK --reviewer <name> --evidence <report>; ...
```

Legacy `reviewer_timeout`, `reviewer_empty` and `review_partial` receipts are failures, not passes: the lane is never
approved by a review that produced no answer. A lane that committed nothing (`base` equals `tip`) closes without a
receipt: an investigation lane has no diff to review. A lane started before this gate has no recorded base; it closes
with an explicit `(no review gate: ...)` note instead of being reviewed against a guessed base. There is no force path:
a BLOCK, a failed review or a missing receipt is resolved by reviewing again, or by
`dori done --drop <key> --reason <text>`, which closes the lane, removes its worktree and branch without landing,
records `dropped` with the reason, and never touches `main`.

## `dori status`

Each lane row ends with `review=reviewed`, `review=queued`, `review=<verdict>` (for example `review=BLOCK`) or
`review=no receipt`, read from the receipt pinned to the lane's current tip (or one whose patch-id matches the current
`base..tip`) and the request record at that tip. `reviewed` means a CLEAR receipt covers the tip; `queued` means the lead has a request to answer; any other verdict means that
receipt refused the tip; `no receipt` means neither.

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
