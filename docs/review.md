# Review: three layers, no pull request, no push

Dori reviews lane work locally. Nothing in this flow contacts a remote: no branch is created, nothing is pushed, and no
pull request is opened. The record of a review is a receipt file under `$DORI_HOME/receipts/`.

## The three layers

| Layer | Who runs it | Evidence |
| --- | --- | --- |
| Lane review | `dori review --lane <key>` starts a fresh, non-interactive reviewer on the lane's own commits | `receipts/lane_<key>@<tip>.json` |
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
   base, the tip, that diff and the worktree as `repo`;
4. runs the reviewer non-interactively (`omo -p --no-session`, or `hooks.reviewCommand` when configured) and reads
   exactly one final `VERDICT: CLEAR|BLOCK` line;
5. writes `receipts/lane_<key>@<tip>.json` with the verdict, base, tip, brief path, reviewer command and time.

The receipt names the exact tip, so it can never describe a different diff. A new commit after a review invalidates it:
review again. A reviewer that prints no VERDICT line writes no receipt; its last 200 output lines are kept as
`receipts/lane_<key>@<tip>-<uuid>.noverdict.txt` (mode 0600) and the command fails.

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
lane <key> at <sha> has no review receipt; run: dori review --lane <key> (or dori done <key> --force)
```

A lane that committed nothing (`base` equals `tip`) closes without a receipt: an investigation lane has no diff to
review. A lane started before this gate has no recorded base; it closes with an explicit `(no review gate: ...)` note
instead of being reviewed against a guessed base. `dori done <key> --force` closes a lane without a CLEAR receipt and
prints that it did, together with the refusal reason; the escape hatch is explicit, never silent.

## `dori status`

Each lane row ends with `review=reviewed`, `review=BLOCK` or `review=no receipt`, read from the receipt pinned to the
lane's current tip. `reviewed` means a CLEAR receipt exists at that tip; `BLOCK` means the receipt at that tip says
BLOCK; `no receipt` means neither (including a lane from before the gate).

## Limits

Each lane commits in its own worktree on branch `lane/<key>`, so `base..tip` is the lane's own history: another lane
cannot add to it, and a lane cannot dirty the main checkout. `dori done` checks the tree is clean, closes the pane,
fast-forwards `main` when it still sits at the recorded base, then removes the worktree and the branch. If `main` moved,
`done` refuses with `main moved: rebase required` and keeps both; `dori done --drop <key> --reason <text>` removes them
without landing. A LOST lane keeps its tree and branch for inspection. Receipts and diffs are per lane key and per tip
commit, so they never collide.
