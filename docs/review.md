# Review: lane request, lead reviewer, lane receipt

Dori reviews lane work locally first. `dori review --lane <key>` does not run a reviewer: it records the lane's current
tip and diff and prints `QUEUED`. The lead (or a human operator) runs one in-process reviewer subagent,
`omo-native-gate-reviewer`, reads its verdict, and records it with `dori review <key> --attest ...`. The record of the
review is `receipts/lane_<key>@<tip>.json`; its schema and the gate rules are unchanged. Once the lane receipt is
CLEAR, `dori merge <key>` is the landing path.

Why: on 2026-11-23 a session reviewer launched by duty died with its omo process after about two minutes and left the
pane `working`; the chunked `omo -p` path timed out and leaked children. The lead's in-process subagent answered in
15-30 minutes through nine rounds. Memory has room for one reviewer subagent (300-500 MB), never two.

## The three layers

| Layer | Who runs it | Evidence |
| --- | --- | --- |
| Lane review | `dori review --lane <key>` records a request; the lead runs one `omo-native-gate-reviewer` subagent and attests its verdict | `receipts/lane_<key>@<tip>.json` |
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
   subagent receives the whole diff and can read the worktree with git when it needs more context;
3. writes one request record and prints `QUEUED <key> <tip> <job>`; it returns at once and spawns nothing. `--model M`
   is recorded on the request for the lead's reference; the queue never runs it.

A request for the same lane and tip while one is queued prints `already queued <job> (queued)` and returns without
adding a second record. `--restart` replaces the request (a new `requestedAt`) and prints `QUEUED ... (restarted)`.
The request record is `$DORI_HOME/state/review-queue/<key>@<tip>.json`, written atomically, holding `lane`, `tip`,
`base`, `model` (when one was given), `requestedAt` and `state`. It stays `queued` until a receipt is recorded or the
request expires.

### The reviewer subagent

The lead launches exactly one reviewer subagent at a time and gives it the rendered `prompts/review-lane.md` contract: the
lane brief, the base, the tip, the saved diff and the worktree. The reviewer contract is the same one the gate has
always used: check the change against the lane's goal for correctness, regressions, missing tests, security issues and
scope creep; list findings by severity (HIGH/MEDIUM/LOW); print exactly one final `VERDICT: CLEAR` (no HIGH or MEDIUM)
or `VERDICT: BLOCK` (at least one HIGH or MEDIUM); do not modify files. A numbered requirement (`rN`) with no change or
evidence behind it is HIGH unless the lane marked it `handed-off` with the recipient.

The lead records the answer:

```
dori review <key> --attest --verdict CLEAR|BLOCK --reviewer <name> --evidence <report> [--evidence ...] [--summary <text>]
```

`--evidence` is required: name the report, task id, path or URL the verdict rested on. The receipt carries the verdict,
base, tip, brief path, reviewer name, time, summary and the evidence links. It names the exact tip, so it can never
describe a different diff: a new commit invalidates it and the lead reviews again. `BLOCK` wins at one tip: a later
CLEAR attest never replaces a BLOCK already on disk; a lane clears a BLOCK only by moving the tip.

### What duty does

`dori duty` drains the queue at the end of each pass. It reads request records only: it reports each waiting request and
expires one older than 24 hours (`DORI_REVIEW_QUEUE_TTL_MS` overrides it), printing `review-queued` or `review-expired`
and dropping the expired record. It never spawns a reviewer, runs `omo -p`, fans out a session, splits a diff, writes a
partial receipt or reuses a checkpoint. A request that cannot be read as a valid job is dropped so it cannot wedge the
queue.

`dori done` never waits on a queued request: while a fresh request exists for the lane's current tip it refuses, naming
the attestation command. Once the receipt exists, `dori merge <key>` lands the lane. `dori status` shows
`review=queued` while the request waits.

The default path never kills a process. `--legacy-kill` (or `DORI_REVIEW_LEGACY_KILL=1`) is the explicit cleanup path
for a reviewer tree an older dori recorded: `--restart --legacy-kill` proves the recorded pid by host and OS start time,
kills that tree, and refuses to replace the request when the kill fails. Without the flag, `--restart` only replaces the
record. `dori done --drop` honors `DORI_REVIEW_LEGACY_KILL=1` when it removes a lane's queued requests.

The PR review path (`dori review <owner/repo#N>` and its `--attest` form) is unchanged.

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
lane <key> at <sha>: a review request is queued (queued, requested <time>); the lead reviews it as a subagent, then records the verdict with dori review <key> --attest --verdict CLEAR|BLOCK --reviewer <name> --evidence <report>; ...
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
`review=no receipt`, read from the receipt pinned to the lane's current tip and the request record at that tip.
`reviewed` means a CLEAR receipt exists; `queued` means the lead has a request to answer; any other verdict means that
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
