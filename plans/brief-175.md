# Task 175: Delete the task branch at every repository layer after a successful close (audit C86-10)

## User request

Successful cleanup leaks every fetched task branch in source submodules. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-09.

This is finding C86-10 (HIGH) in plans/task-86-codex-audit.md.

The merge path fetches each submodule's task-N branch into the canonical source submodule (mergeSubmoduleBranchIntoRepo, scripts/mergeTaskWorktrees.ts:419-428), creating refs/heads/<groupBranch> there on every merge. On success the workflow calls removeWorktreeAndBranch exactly once, for the root (skills/tackle-tasks/task.workflow.js:703-705). That helper removes only the root worktree and the root branch (scripts/mergeTaskWorktrees.ts:439-442); it never deletes the fetched task-N refs from the source submodules. Every run therefore leaks one ref per submodule.

mergeGroupBranchIntoRepo already iterates submodulePathsDeepestFirst and knows each submodule's checkout and source path during the merge loop, so that layer information needs to reach the cleanup step -- or cleanup must re-derive the submodule paths and branch names -- so the branch is deleted at every repository layer, not only the root.

The required cleanup test is a FALSE POSITIVE: tests/mergeTaskWorktrees.test.ts:1508-1530 manually runs `git branch -D` inside the submodule near the end of the test, supplying the very production behaviour it should have asserted. It must be rewritten to assert the fetched branch is absent without deleting anything itself.

## Files

@scripts/mergeTaskWorktrees.ts
@skills/tackle-tasks/task.workflow.js
@tests/mergeTaskWorktrees.test.ts