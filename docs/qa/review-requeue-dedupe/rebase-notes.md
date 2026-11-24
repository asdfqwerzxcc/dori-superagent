# Rebase onto be8b5de (review-fallback-on-error + design-lane-gate)

- `test/hooks.test.ts`: took main's richer `gh` stub (`view` returns `headRefOid`/`title`/`body`, `diff` returns a real diff, else exit 1); the lane's older fixture patch was dropped because main's 4517921 already fixes it.
- `src/cli-args.ts`: kept main's lane-merge usage and appended the lane review `--lane ... --restart` block; kept the `restart` boolean flag.
- `src/cli.ts`: kept main's lane-merge and attest spread; routed `review --lane` through `runReviewLane`; removed the now-unused `reviewLane` import.
- `src/lane-review-chunks.ts`: kept main's `attemptChunk`/`saveChunkOutcome` fallback flow; added `checkLive`, `stopOnKillFailure` and `killFailure` so a failed kill stops before the next chunk.
- `src/lane-review-single.ts`: kept main's fallback/primary-down flow; added the `stopKill` gate and `checkLive`.
- `src/review-attempt.ts`: kept main's chunk retry/skip/primaryDown/re-split rules; added `checkLive` and early `killFailed` returns before any fallback.
- `src/lane-review-final.ts` (main's finalizer): added `killFailure` and forced `reviewer_timeout` before `anyBlock`.
- `src/lane-review.ts`: kept main's `RetryFacts` diagnose and fallback wiring; added the queue options and the `checkLive`/pid pass-through.
- `src/review-report.ts`: kept main's `failureCause`/`primaryUnusable`/auth helpers; added `killFailed` and its receipt/exit text.
- `src/review-progress.ts`: kept main's `primaryDown` fields; kept the `checkLive` fence in `saveFinalReceipt`.
- `src/review-run.ts`: kept the lane's process-group spawn, pid sidecar callback and kill-failure outcome.
- `docs/review.md`: merged main's fallback wording with the queue/identity/failed-kill paragraphs.
