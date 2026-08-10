# Task 176: Make worktree discovery recognize task-N so --discover can recover a failed task (audit C86-11)

## User request

Worktree recovery/discovery still recognizes only the retired naming convention. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-10.

This is finding C86-11 (MEDIUM) in plans/task-86-codex-audit.md.

listTaskWorktrees filters worktree basenames with /^group-\d+$/ (scripts/mergeTaskWorktrees.ts:47-56), a naming convention from the retired tackle-tasks implementation. The current preparer creates task-N instead (createWorktreeForGroup, scripts/prepareTasks.ts). findUnmergedTaskWorktrees calls listTaskWorktrees, so the --discover recovery path cannot see any worktree this implementation creates -- it finds nothing.

LEGACY DECISION, settled with the user: ignore legacy artifacts entirely. Fix the filter so discovery recognizes task-N, and do NOT report, migrate, or delete the leftover group-* worktrees and task-group-* branches from the previous implementation. They stay exactly as they are, untouched and unmentioned. This closes out the audit's open question about whether the migration should report or clean them: the answer is neither.

Context for whoever reads this later: the administrative worktree list really does still contain several legacy group-* worktrees on task-group-* branches. The audit observed them and deleted nothing; so does this task.

## Files

@scripts/mergeTaskWorktrees.ts
@tests/mergeTaskWorktrees.test.ts