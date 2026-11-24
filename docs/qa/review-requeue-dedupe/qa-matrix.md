# QA matrix — review requeue dedupe and reviewer tree lifetime

Environment: win32, Bun 1.4.4. All commands run in
`C:/Users/USER/.dori/worktrees/review-requeue-dedupe`, rebased onto be8b5de (review-fallback-on-error +
design-lane-gate). Per-file conflict resolutions are in `rebase-notes.md`.

| # | Check | Command / artifact | Result |
|---|-------|--------------------|--------|
| Q1 | Three in-flight `review --lane` calls return one job and one reviewer pair | `docs/qa/review-requeue-dedupe/live-repro.txt` (call1 QUEUED, call2/call3 `already queued ... (running)`; pids 20580,27364 only) | PASS |
| Q2 | `--restart` kills the old reviewer tree and starts one new pair | same transcript (old pair dead, new pair 28640,26556 alive) | PASS |
| Q3 | A stale marker with a live unrelated pid does not kill it; the marker is dropped | `bun test ./test/review-requeue-identity.test.ts` | PASS |
| Q4 | A marker with a mismatched start time (pid reuse) does not kill the live process | `bun test ./test/review-requeue-identity.test.ts` | PASS |
| Q5 | A verified live marker survives `clearRun` until its process exits | `bun test ./test/review-requeue-identity.test.ts` | PASS |
| Q6 | The finish path cannot delete a job a restart wrote at the same path | `bun test ./test/review-requeue-identity.test.ts` | PASS |
| Q7 | A timeout kills the reviewer and its provider child | `bun test ./test/lane-review-kill.test.ts` | PASS |
| Q8 | A kill that cannot land reports why | `bun test ./test/lane-review-kill.test.ts` | PASS |
| Q9 | In-flight dedupe, restart replacement and inline takeover | `bun test ./test/review-requeue.test.ts ./test/review-queue.test.ts` | PASS |
| Q10 | Receipt lock behavior after the shared process-identity refactor | `bun test ./test/lane-review-receipt-lock.test.ts ./test/lane-review-lock-live.test.ts` | PASS |
| Q11 | Full test suite | `bun test ./test/` | PASS — 768 pass, 27 skip, 0 fail (795 tests, 99 files) |
| Q12 | Types | `bun run typecheck` | PASS (exit 0) |
| Q13 | Changed-file lint | `bunx --bun @biomejs/biome check <changed files>` and `bunx --bun oxlint <changed files>` | PASS |
| Q14 | File-size rule | `bun scripts/check-loc.ts` | Only the pre-existing `src/cli.ts` over cap (284 lines; 293 on main be8b5de) |
| Q15 | A failed tree kill stops the fallback: one reviewer call, job and marker kept, original pair alive | `bun test ./test/review-kill-fatal.test.ts` | PASS |
| Q16 | A failed tree kill stops the next chunk: first chunk `timed out`/`not run`, job and marker kept, original pair alive | `bun test ./test/review-kill-fatal.test.ts` | PASS |
| Q17 | Chunk 1 BLOCK + chunk 2 failed kill: receipt `reviewer_timeout` (not BLOCK), chunks `["BLOCK","timed out"]`, job+marker kept, pair alive | `bun test ./test/review-kill-fatal.test.ts` | PASS |
| Q18 | A BLOCK verdict printed before a failed kill: receipt `reviewer_timeout`, job+marker kept, pair alive | `bun test ./test/review-kill-fatal.test.ts` | PASS |
| Q19 | Upstream fallback contract still passes after the rebase | `bun test ./test/lane-review-fallback.test.ts ./test/lane-review-fallback-primary-down.test.ts` | PASS |
| Q20 | Rebased lane E2E (dedupe, identity, fatal kill, timeout tree) | `bun test ./test/review-kill-fatal.test.ts ./test/review-requeue.test.ts ./test/review-requeue-identity.test.ts ./test/lane-review-kill.test.ts` | PASS |
