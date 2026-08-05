---
name: merge-worktree-tasks
description: check leftover taskTools worktrees for unmerged commits or uncommitted edits, match them to open tasks by file overlap, and merge back into the repo only after explicit user approval
---

- repo root: !`pwd`
- unmerged worktrees: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts" --discover`

Invoke `/ponytail:ponytail ultra`.

The block above is a JSON array of `UnmergedTaskWorktree` objects: `worktree`
(path), `branch`, `unmergedCommitCount`, `hasUncommittedChanges`,
`changedFilePaths`, and `matchedTaskNumbers` — the still-open task numbers
whose declared `files` overlap what changed in that worktree. An empty array
means nothing to merge: say so and stop, do not proceed to any step below.

## Report

List every worktree in the array: branch, worktree path, unmerged commit
count, whether it has uncommitted changes, and its matched task numbers. A
worktree with an empty `matchedTaskNumbers` is still reported — say "no open
task matched" for it, never drop it from the list silently.

## Approval gate

For each reported worktree, ask via `AskUserQuestion` whether to merge it —
name the branch, the worktree path, and the matched task numbers in the
question so the user knows exactly what they're approving. Never merge a
worktree without an explicit approval for that specific worktree; a blanket
"looks fine" for the whole list is not per-worktree approval unless the
question itself was posed that way and the user answered yes to it.

## Merge only what was approved

For every approved worktree, run:

`node "${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts" --merge <worktree path>`

Each call prints one `MergeOutcome` JSON object. If `merged: true`, the
worktree and its branch are already removed by the script — report success
and, if it had matched task numbers, note that those tasks' work is now on
the branch you were on when you ran `--discover`. If `merged: false`, report
`conflictedFilePaths` / `failureReason` and leave it — the worktree is still
on disk for manual resolution; do not retry the merge automatically and do
not delete the worktree yourself.

Do not run `--merge` for any worktree the user did not approve.

## Scope note

`--merge` merges only the parent repository's branch (it auto-resolves
submodule *pointer* conflicts the same way the normal tackle-tasks merge
step does). It does not merge a submodule's own content branch. If a
worktree touches a submodule, say so in the report so the user knows to
check that submodule separately — do not claim the merge is complete for
submodule work it didn't touch.
