# Task 168 Plan: Make the gitlink-conflict rebase continuation non-interactive

## Root cause

`git(repoRoot, ...args)` at scripts/mergeTaskWorktrees.ts:19-21 calls `execFileSync` with no `env` override, so it inherits the parent process's interactive editor config. When `rebaseGroupOntoSource` (scripts/mergeTaskWorktrees.ts:205) runs `git(worktreePath, "rebase", "--continue")` after auto-resolving an allowed gitlink conflict, that continuation opens an editor and hangs forever in a noninteractive context (e.g. `git commit --no-edit` fallback, or the rebase continuation itself needing to write a commit message with no `-m`).

## Fix

Add `GIT_EDITOR: "true"` to the `env` passed to every `git()` call, by setting it once in the shared helper — matching the working reference pattern in `continueRebaseChecked` (skills/tackle-tasks/task.workflow.js), which passes `env: { ...process.env, GIT_EDITOR: 'true' }` to `execFileSync` for the same `git rebase --continue` call. This is the settled fix site per the brief: the helper fix also covers the latent hang on `git merge`, `git merge --abort`, and `git commit --no-edit` in the same file.

## Edit

### scripts/mergeTaskWorktrees.ts:19-21

Current text:

```ts
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
```

Becomes:

```ts
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_EDITOR: "true" },
    });
}
```

No other lines in scripts/mergeTaskWorktrees.ts change. Every other function in the file (`rebaseGroupOntoSource`, `resolveGitlinkConflicts`, `mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`, etc.) already calls through this single `git()` helper, so they inherit the noninteractive env automatically and need no edit of their own.

## tests/mergeTaskWorktrees.test.ts

No edit needed. This file owns no source of the hang: its local `git()` helper (tests/mergeTaskWorktrees.test.ts:31-33) is test-fixture plumbing for setting up repos, not the code under test, and none of its setup calls (`checkout`, `add`, `commit -q -m "..."`, `submodule add -q`) invoke an editor — every commit in the file passes `-m` explicitly. The existing test `test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested` (tests/mergeTaskWorktrees.test.ts:1071-1113) already reproduces the hang today and already asserts the correct passing behavior (`{ status: "rebased-and-tested" }`, no `rebase-merge`/`rebase-apply` directory, gitlink recorded as `commitA`) once the helper fix lands — it needs no new assertions, only to stop hanging.

## Verification

Run from /Users/matkatmusicllc/Programming/taskTools-86:

1. `npm test -- --test-name-pattern=test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested`
   Expected: the test completes (does not hang) and passes, in well under 6 minutes.

2. `npm test`
   Expected: the full suite in tests/ (node --test) completes and passes, with no hang on any test that exercises `rebaseGroupOntoSource`, `rebaseParentOntoSourceAndTest`, `resolveGitlinkConflicts`, `mergeGroupBranchIntoRepo`, or `mergeSubmoduleBranchIntoRepo`.
