# Delta review after the gate BLOCK at 6f6c138

Scope: the queue/process-lifetime delta only. Earlier behavior (dedupe message, normal
timeout and restart kills) was already accepted by the gate and is unchanged except
where this report says so.

## Finding 1 (MEDIUM): a bare persisted pid is not an identity

- Fix: `ReviewRun` now carries `host` and the reviewer's OS `startTime`, captured at
  spawn in `reviewerIdentity`. `killRecordedRun`, `killRunFile` and `cancelLaneReviews`
  kill only when the pid is alive, the host is this host, and the OS start time still
  matches; an unprovable, foreign, dead or reused pid drops the marker and touches no
  process. The same helper is used by the drain claim, `--restart`, the inline takeover
  and lane drop.
- Shared identity reads live in `src/process-identity.ts`; `src/receipt-lock.ts` now
  imports the same liveness and start-time helpers instead of keeping a second copy.
- Evidence: `test/review-requeue-identity.test.ts` — a stale marker with no identity and
  a marker with a mismatched start time both name a live, unrelated process; the process
  survives and the marker is dropped. The live transcript shows the real marker
  `{requestedAt, pid, host, startTime}`.

## Finding 2 (LOW): kill failures were swallowed and the marker cleared anyway

- Fix: `killReviewTree` returns a discriminated `KillOutcome`. `runReviewer` records a
  failed tree kill, prints it on the progress/stderr channel, and does not call
  `onPid(undefined)`, so the marker keeps the identity for a retry. `clearRun` keeps a
  marker that still names a verified live process and removes it once that process is
  gone. The drain skips a job whose verified kill failed and emits
  `review-kill-failed`; a kill that fails after an attempt keeps both the job record
  (`liveRun`) and the marker so the next pass retries it; `--restart` refuses and leaves
  the old job in place; lane drop
  writes the failure to stderr.
- Evidence: `test/lane-review-kill.test.ts` — a kill that cannot land reports its
  reason; `test/review-requeue-identity.test.ts` — a verified live marker survives
  `clearRun` until the process exits.

## Finding 3 (LOW): the finish path could erase a concurrently restarted job

- Fix: `finishJob` renames the record to a unique tombstone, deletes it only when the moved
  record still carries the drain's `requestedAt`, and restores any newer record with a
  hard link (which cannot overwrite) before returning `false`. Both the success and
  failure finish paths use it; an old drain now reports `review-cancelled` and leaves the
  restart's record alone.
- Evidence: `test/review-requeue-identity.test.ts` — a record for `requestedAt` 1000 is
  replaced with 1001; `finishJob(path, 1000)` returns false and leaves 1001 intact.

## Finding 4 (MEDIUM, second gate): a failed tree kill did not stop the attempt

- Symptom: `runReviewer` recorded a failed kill but returned a normal timeout, so `reviewSingle` spawned the fallback
  and `reviewChunks` started the next chunk. Each spawn rewrote the single `.running` marker; when the second attempt
  succeeded the drain deleted the job and cleared the marker while the first pair was still alive. With no fallback
  the job was kept, which is why the first test missed it.
- Fix: the timeout outcome carries `killFailed`; a failed kill marks the attempt itself (not the answer) failed.
  `reviewSingle` returns the failure receipt before the fallback branch; `reviewChunks` records the chunk, marks the
  remaining plan `not run` and stops through `stopOnKillFailure`; `finishChunks` names the kill failure in the
  `reviewer_timeout` receipt and refusal. The marker keeps the original pid identity, so the drain's `liveRun` path
  keeps the job record and the next pass retries.
- Evidence: `test/review-kill-fatal.test.ts` — a real reviewer-shaped process pair, an injected failing killer, exactly
  one reviewer call (no fallback, no next chunk), the job record and marker present, both original pids alive, and a
  `reviewer_timeout` receipt containing the kill failure.

## Finding 5 (LOW, second gate): restore and cancel paths

- `finishJob` now distinguishes `EEXIST` (a newer record owns the path; discard the tombstone) from every other
  `linkSync` error, which is written to stderr and leaves the record in its unique tombstone instead of losing it.
- `cancelLaneReviews` now keeps a job record and marker when its verified kill fails, matching the drain path; the
  lane drop reports the failure on stderr and proceeds with the drop.

## Finding 6 (MEDIUM, third gate): BLOCK outranked a failed kill

- Symptom: `finishChunks` evaluated `anyBlock` before `timedOut`/`killFailure`. A chunked review with an earlier BLOCK
  (or a BLOCK printed before a hang) finished as BLOCK; the drain's success path deleted the job and ignored the
  retained marker, so the live pair stayed untracked. The drain's `liveRun` branch was only reached on a throw.
- Fix: `killFailure` is evaluated first and forces `reviewer_timeout`; `finishChunks` throws the refusal naming the kill
  failure, so the drain's `liveRun` path keeps the job and marker. The drain also checks `liveRun` on the success path
  before deleting the job, as a second guard.
- Evidence: `test/review-kill-fatal.test.ts` — chunk 1 BLOCK, chunk 2 kill fails: receipt `reviewer_timeout`, chunks
  `["BLOCK","timed out"]`, job+marker kept, the original pair alive; and a single BLOCK verdict printed before a failed
  kill is `reviewer_timeout`.

## Rebase onto be8b5de

Rebased after `review-fallback-on-error` (bb1bbff) and `design-lane-gate` (be8b5de), both of which
touch the review pipeline. Both behaviors are kept: the fallback contract (`primaryDown` with cause,
retried/retryModel diagnostics, re-split, a both-down chunk never CLEAR) and the lane's dedupe, verified
kill identity, failed-kill abort, killFailure-first verdict, and `liveRun` job retention. Per-file
resolutions are listed in `rebase-notes.md`; the fallback and lane E2E tests pass on the rebased tip.

## Residual risks

- When the OS cannot report a start time, the marker fails closed: the cross-process
  kill is skipped. The in-process timeout path still holds the real process handle and
  kills its tree directly.
- `finishJob`'s restore needs hard links; the repository already relies on them for
  lock acquisition, and the path is only reached when a restart races a finish.
- Host and start-time checks make killing safe, not immediate: a verified reviewer that
  cannot be killed is retried on the next duty pass instead of spawning a second one.
