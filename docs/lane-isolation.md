# Lane isolation: one worktree per lane

Every lane works in a git worktree of its own, created from the commit the harness saw when the lane started, and lands
through `dori done` only. A lane cannot dirty the main checkout, another lane cannot add commits to its range, and a
review can only ever describe that lane's work.

## The invariant

A lane's receipt range is exactly its own commits: `base..tip`, where `base` is the merge-base of the lane's recorded
start commit and its current tip, measured in the lane's own checkout. `dori start` records the landing repository
(`repo`) and its HEAD as `baseSha`; the lane record also carries the current `tipSha`, refreshed at every review.
`dori review --lane <key>` diffs `merge-base(baseSha, tip)..tip`, so a main branch that moved after the start adds
nothing to the reviewed range. The receipt is written per lane key and per tip commit, so a new commit invalidates it:
review again, or drop the lane.

## What `dori start` sets up

- Resolves the landing repository: the caller's `--cwd` (or the cwd) when it is a repository, else the harness checkout
  `$DORI_HOME/src`. A lane started where neither path is a repository (or the repository has no commit yet) records no
  worktree: there is nothing to isolate.
- Records `repo` and `baseSha = git rev-parse HEAD` in the lane record.
- Runs `git worktree add -b lane/<key> <root>/<key> <baseSha>`, where `<root>` is `$DORI_WORKTREES_DIR` when set and
  `$DORI_HOME/worktrees` otherwise.
- Locks the tree (`git worktree lock --reason "dori lane <key>"`) and proves the branch descends from `baseSha` with
  `git merge-base --is-ancestor`. Only then does it open the lane's pane with the worktree as its cwd.

## The two close paths

`dori done <key>` is the landing path, and it refuses unless every step holds:

1. The lane is `ready` (a final answer was recorded) and its current tip has a CLEAR receipt. A lane that committed
   nothing (`base` equals `tip`) closes without a receipt; a lane recorded before this gate has no `baseSha` and closes
   with an explicit note.
2. The worktree is clean: `git status --porcelain` must be empty, and a dirty tree is refused before any git mutation,
   naming the files exactly as git does.
3. The lane's pane must not be `working`, `blocked` or `error`; it is closed first, because Windows refuses to remove
   a directory a pane holds.
4. `main` must still sit at the recorded base. The branch is landed with `git merge --ff-only lane/<key>`; a branch that
   already landed (it is an ancestor of `main` HEAD) closes on a retry, but a `main` that moved for another reason is
   refused with `main moved: rebase required`, keeping branch and worktree.
5. Teardown unlocks the tree, removes it (one retry when Windows holds it) and deletes `lane/<key>` with
   `git branch -d`. An unlocked tree and a tree git already forgot count as already torn down, not as a failure.

`dori done --drop <key> --reason <text>` is the explicit abandonment path: it closes the pane, removes the worktree and
the branch with `git branch -D`, records `dropped` with the reason, and never merges or touches `main`. It needs a
non-empty reason and refuses an already-done lane. That is the exit for abandoned work, a base that moved too far, and a
lost lane, whose worktree and branch are kept for inspection until it is dropped.

## Failure modes the model prevents

| Failure mode | What would happen | What dori does instead |
| --- | --- | --- |
| Shared checkout | A lane commits into the lead's or another lane's checkout, so its "diff" contains work it never did and `done` cannot land cleanly | Each lane gets its own tree on `lane/<key>` and its pane opens there; `dori status` prints `MISMATCH <key>: pane cwd ... is not its worktree ...` when a pane runs elsewhere, and the lane review still reads the lane's tree |
| Moved base | Reviewing or landing `main..lane` attributes other lanes' new commits to this lane, or overwrites them | Review starts at the merge-base of the recorded base and the tip; landing is fast-forward only, from the recorded base, and a moved `main` refuses instead of forcing |
| Orphan worktree | A crashed start or a closed lane leaves a registered tree and branch behind, consuming disk invisibly | `dori worktrees list` names every tree with its lane status and orphan reason (`lane done`, `lane dropped`, `lane lost`, `no lane record`, `path missing`, `not registered`, `stale lock`); `dori worktrees prune` removes clean orphans and their branches, and `dori status` adds one `WORKTREES <n> orphan` line while any exist |
| Silent fallback | A lane whose worktree could not be created quietly commits into the shared checkout while the isolation guarantee is believed | A failed add, lock or ancestry check refuses the start with `worktree_unavailable: <git reason>` before any pane opens; a branch the failed add created is deleted, and no lane record is written. There is no fallback to the shared checkout |

A failed start is loud, never a lane. The hourly loop records `start <id> failed: <reason>` in the run's findings, keeps
the item `open` with a `startFailures` count, and after two failed starts turns it into a `DECIDE:` question in
`dori backlog list`: the work waits visibly for a human instead of running unisolated.

`dori worktrees prune` never uses `--force`: it names a dirty tree and leaves it, reports a stale HEAD lock and leaves
the tree, and skips a tree with no readable repository. A live lane's tree (`working`, `waiting`, `ready`) is never an
orphan, so a running lane cannot be pruned out from under its pane.

## Commands

| Command | What it does |
| --- | --- |
| `dori start <key> --brief FILE [--cwd DIR]` | records the base, creates and locks `worktrees/<key>` on `lane/<key>`, and opens the pane there |
| `dori review --lane <key> [--model M]` | diffs `merge-base(baseSha, tip)..tip` in the lane's tree and writes `receipts/lane_<key>@<tip>.json` |
| `dori done <key>` | requires a CLEAR receipt at the current tip and a clean tree, closes the pane, fast-forwards `main`, removes the tree and branch |
| `dori done --drop <key> --reason TEXT` | closes the lane without landing: removes the tree and `lane/<key>`, records `dropped` with the reason |
| `dori worktrees list` | prints `WORKTREES root=...`, one `TREE <key>` line per tree with status, path, repo, dirty count, locks and orphan reason, then `WORKTREES <n> orphan` |
| `dori worktrees prune` | removes clean orphan trees and their `lane/<key>` branches, printing `REMOVED`/`DELETED`, `DIRTY`, `LOCKED` or `SKIPPED` per tree, then `WORKTREES <n> pruned` |
| `dori status` | prints the lane table, `MISMATCH <key>: ...` for a pane outside its worktree, and `WORKTREES <n> orphan` while any exist |

## Limits

- The worktree is isolation for commits, not for processes: the lane's pane is a normal process that can still reach
  the main checkout by absolute path.
- The base is recorded once and never updated. A lane that rebases onto a moved `main` is still reviewed from the
  merge-base with its recorded base, which can then include commits from outside the lane; `dori done` still refuses to
  land onto a `main` that moved, so that path ends in `--drop` or a lead-side landing.
- `dori worktrees prune` removes an orphan tree even when its lane record says `lost`; the branch goes with it. Inspect
  a lost lane before pruning it.
