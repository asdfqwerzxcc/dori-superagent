# Lane isolation: one worktree per lane

Every lane works in a git worktree of its own, created from the commit the harness saw when the lane started, and lands
through `dori merge <key>` (the lane gate) only; `dori done` closes and cleans up after the PR lands. A lane cannot dirty
the main checkout, another lane cannot add commits to its range, and a review can only ever describe that lane's work.

## The invariant

A lane's receipt range is exactly its own commits: `base..tip`, where `base` is the merge-base of the lane's recorded
start commit and its current tip, measured in the lane's own checkout. `dori start` records the landing repository
(`repo`) and its HEAD as `baseSha`; the lane record also carries the current `tipSha`, refreshed when a review request is
queued. `dori review --lane <key>` diffs `merge-base(baseSha, tip)..tip`, saves the diff under `lane-reviews/` and
records a request; the lead reviews it as a subagent and writes the receipt with `dori review <key> --attest`. A main
branch that moved after the start adds nothing to the reviewed range. The receipt is written per lane key and per tip
commit, and carries the `git patch-id` of `base..tip`. A new commit with different content invalidates it: review again,
or drop the lane. A rebase that leaves the diff unchanged (context included) keeps it valid, because the gate compares
the current patch-id with the ids on disk when no receipt exists at the new tip.

## What `dori start` sets up

- Resolves the landing repository: the caller's `--cwd` (or the cwd) when it is a repository, else the harness checkout
  `$DORI_HOME/src`. A lane started where neither path is a repository (or the repository has no commit yet) records no
  worktree: there is nothing to isolate.
- Records `repo` and `baseSha = git rev-parse HEAD` in the lane record.
- Runs `git worktree add -b lane/<key> <root>/<key> <baseSha>`, where `<root>` is `$DORI_WORKTREES_DIR` when set and
  `$DORI_HOME/worktrees` otherwise.
- Locks the tree (`git worktree lock --reason "dori lane <key>"`) and proves the branch descends from `baseSha` with
  `git merge-base --is-ancestor`. Only then does it open the lane's pane with the worktree as its cwd.

## The landing path and the close paths

`dori merge <key>` is the landing path: it pushes the lane branch, opens or updates the PR, gates on checks, merges with
a merge commit, and deletes the remote branch. `dori done <key>` is the close/cleanup path, and it refuses unless every
step holds:

1. The lane is `ready` (a final answer was recorded) and its current tip is covered by a CLEAR receipt (the exact tip,
   or the same patch-id). A lane that committed nothing (`base` equals `tip`) closes without a receipt; a lane recorded
   before this gate has no `baseSha` and closes with an explicit note.
2. The worktree is clean: `git status --porcelain` must be empty, and a dirty tree is refused before any git mutation,
   naming the files exactly as git does.
3. The lane's pane must not be `working`, `blocked` or `error`; it is closed first, because Windows refuses to remove
   a directory a pane holds.
4. `main` already contains the lane branch from the PR merge (or still sits at the recorded base, in which case `done`
   fast-forwards it as a legacy local fallback). A `main` that moved without the lane is refused with
   `main moved: rebase required`, keeping branch and worktree.
5. Teardown unlocks the tree, removes it (one retry when Windows holds it) and deletes `lane/<key>` with
   `git branch -d`. An unlocked tree and a tree git already forgot count as already torn down, not as a failure.

`dori done --drop <key> --reason <text>` is the explicit abandonment path: it closes the pane, removes the worktree and
the branch with `git branch -D`, records `dropped` with the reason, and never merges or touches `main`. It needs a
non-empty reason and refuses an already-done lane. That is the exit for abandoned work, a base that moved too far, and a
lost lane, whose worktree and branch are kept for inspection until it is dropped.

## Failure modes the model prevents

| Failure mode | What would happen | What dori does instead |
| --- | --- | --- |
| Shared checkout | A lane commits into the lead's or another lane's checkout, so its "diff" contains work it never did and the lane gate cannot land it cleanly | Each lane gets its own tree on `lane/<key>` and its pane opens there; `dori status` prints `MISMATCH <key>: pane cwd ... is not its worktree ...` when a pane runs elsewhere, and the queued diff and the lead's reviewer still read the lane's tree |
| Moved base | Reviewing or landing `main..lane` attributes other lanes' new commits to this lane, or overwrites them | Review starts at the merge-base of the recorded base and the tip; the lane gate lands the PR, and `done` accepts a main that contains the lane branch but refuses a main that moved without it instead of forcing |
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
| `dori review --lane <key> [--model M]` | diffs `merge-base(baseSha, tip)..tip` in the lane's tree, saves the diff, and records a request (`QUEUED`); a reviewer session (`dori review <owner/repo#N> --background`) reads it, and its verdict is attested into the lane receipt |
| `dori merge <key>` | lane gate: pushes `lane/<key>`, opens/updates the PR, gates on checks, merges with a merge commit, deletes the remote branch |
| `dori done <key>` | requires a CLEAR receipt covering the current tip (exact or same patch-id) and a clean tree; verifies `main` contains the lane branch from the PR merge (or fast-forwards from the recorded base), then removes the tree and local branch. A lane whose tree is already gone closes as landed only when `lane/<key>` itself (or its recorded tip with a CLEAR receipt, after the branch was deleted by the landed close) is on `main`; otherwise `--drop` is the explicit exit |
| `dori done <key> --rebase` | moves the lane onto the current `main` first and re-records its base; the old receipt still applies when its patch-id matches the rebound tip, otherwise review again before `dori merge <key>` lands it |
| `dori done --drop <key> --reason TEXT` | closes the lane without landing: removes the tree and `lane/<key>`, records `dropped` with the reason |
| `dori worktrees list` | prints `WORKTREES root=...`, one `TREE <key>` line per tree with status, path, repo, dirty count, locks and orphan reason, then `WORKTREES <n> orphan` |
| `dori worktrees prune` | removes clean orphan trees and their `lane/<key>` branches, printing `REMOVED`/`DELETED`, `DIRTY`, `LOCKED` or `SKIPPED` per tree, then `WORKTREES <n> pruned` |
| `dori status` | prints the lane table, `MISMATCH <key>: ...` for a pane outside its worktree, and `WORKTREES <n> orphan` while any exist |

## Limits

- The worktree is isolation for commits, not for processes: the lane's pane is a normal process that can still reach
  the main checkout by absolute path.
- The base is recorded when the lane starts, and the only supported way to move it is `dori done <key> --rebase`: it
  rebases the lane onto the current `main` inside the lane's own tree and re-records `baseSha`; a rebase that leaves
  the diff unchanged (context included) keeps the patch-id, so the old receipt still covers the new tip. A rebase that
  changed the diff needs a new review before `dori merge <key>` lands it. Without `--rebase`, `done` refuses a `main`
  that moved without the lane (`main moved: rebase required`) and keeps the branch and tree.
- `dori worktrees prune` removes an orphan tree even when its lane record says `lost`; the branch goes with it. Inspect
  a lost lane before pruning it.
