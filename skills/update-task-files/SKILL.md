---
name: update-task-files
description: backfill the `files` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.
argument-hint: "[N,N,...]"
---

- repo root: !`pwd`
- task details: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS[0]'`

First, invoke `/ponytail:ponytail ultra`.

Add a `files` array to each task shown above, inserted after `description`. If a task
already has one, verify it against the current codebase rather than rewriting it.

Invocation format: the first argument is a JSON array of task numbers with **no spaces** —
`[332,335]`. If no numbers were given, the block above lists every task; ask the user which
ones to backfill rather than rewriting all of them.

## Path rules

- Repo-relative to the repo root printed above — the directory holding `tasks.json`. Never
  absolute, never relative to a subdirectory.
- Files inside a git submodule are still written relative to that same root, so they carry
  the submodule directory as a prefix (for example `jfred/tests/layer1-filenav.test.ts`).
- Every path must already exist on disk. Verify each one. A path that does not resolve
  silently degrades the task's brief to `(missing: file not found)` at run time.
- Include implementation files and their test files.

## Why accuracy matters

This list is load-bearing, not documentation. Two mechanisms read it:

1. **Ownership fence.** The worker implementing the task is told "touch nothing outside
   them". Under-declaring blocks the worker from files it needs.
2. **Concurrency key.** Tasks sharing any path are sequenced together inside one git
   worktree; tasks with disjoint paths run in parallel in separate worktrees.
   Over-declaring serializes work that could have run concurrently. Under-declaring lets
   two workers edit the same file in different worktrees, which surfaces later as a merge
   conflict.

List what the task genuinely touches — not the whole module, and not one file when the
change spans three.

## When you cannot tell

If a task is too vague to determine its files, leave that task's `files` field out and
report its number. A wrong list is worse than no list: the task will simply be refused
again, which is the correct outcome for a task that needs rethinking rather than
annotating.

## Editing rules

- Edit `tasks.json` in place. Do **not** use the `create-task` skill — that skill appends
  new tasks, and this is a field backfill on existing ones. The rule against editing
  `tasks.json` directly governs *adding* tasks, which this skill does not do.
- Never touch `completedTasks.json`.
- Preserve every existing field, key order, task order, and task number. Do not reformat,
  reorder, renumber, or drop any entry.
- Change no source code.

## Verify before reporting

- The task count in `tasks.json` is unchanged.
- Every path you added exists: check each one on disk.
- `git diff` shows changes to `tasks.json` only.

## Report

A table of task number to files, then a separate list of the task numbers you left without
a `files` field, each with the reason it could not be determined.
