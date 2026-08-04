# Task 37 Plan: unblockedTaskNumbers helper + `--unblocked` support

## Goal
Add a shared `unblockedTaskNumbers(openTasks)` helper (tasks with empty/absent
`blockedBy[]`, ascending), consume it from `checkBlockers.ts`, and fix
`prepareTasks.ts` so `--unblocked` expands to those numbers instead of
throwing "no task numbers given". This is the plumbing the future
`/tackle-unblocked-tasks` skill will drive; no skill directory is created
here.

Owned files only: `scripts/taskFiles.ts`, `scripts/checkBlockers.ts`,
`scripts/prepareTasks.ts`.

## 1. scripts/taskFiles.ts
Add and export:
```ts
export function unblockedTaskNumbers(openTasks: TaskRecord[]): number[] {
  return openTasks
    .filter((t) => !Array.isArray(t.blockedBy) || t.blockedBy.length === 0)
    .map((t) => t.taskNumber)
    .sort((a, b) => a - b);
}
```
Place it near the other task-list helpers (after `readTaskFile`).

## 2. scripts/checkBlockers.ts
Import `unblockedTaskNumbers` and use it as the source of truth for the
`--unblocked`-only output branch, replacing the ad-hoc filter:

```ts
if (unblockedOnly) {
  const unblocked = new Set(unblockedTaskNumbers(openTasks));
  process.stdout.write(requested.filter((n) => unblocked.has(n)).join(" ") + "\n");
}
```

Leave `openBlockersOf` and the verbose (non-flag) branch untouched — that
branch reports *which* open tasks are blocking (`BLOCKED by open task(s) …`),
which needs the actual blocker numbers, not just an unblocked/blocked
boolean. Only the `--unblocked` list itself moves onto the shared helper.

Note: this narrows the `--unblocked` flag's definition from "no still-open
blockers" to "blockedBy is empty/absent" — matching the brief's explicit
spec for `unblockedTaskNumbers`. A task whose `blockedBy` still lists a
now-closed task will no longer count as unblocked via this flag unless that
entry is removed. This is what the brief asks for; flagging it here in case
it's a surprise to whoever reviews the diff.

## 3. scripts/prepareTasks.ts
Import `unblockedTaskNumbers` from `./taskFiles.ts`. In `runAsCli()`, detect
the flag before parsing task numbers and branch:

```ts
const args = process.argv.slice(2);
const useUnblocked = args.includes("--unblocked");
const requestedNumbers = useUnblocked
    ? unblockedTaskNumbers(openTasks)
    : leadingTaskNumbers(args);
```

Everything downstream (`selectRequestedTasks`, brief-writing, grouping,
`buildWorkflowArguments`) is unchanged — `--unblocked valid` now reaches
`selectRequestedTasks` with the same shape of array `[268,270]` would have
produced, so it drives the identical code path.

## Verification
No test file is in this task's owned-files list, so verification is manual,
not committed:
- `bun scripts/checkBlockers.ts --unblocked` against a scratch tasks.json
  with a mix of empty/non-empty `blockedBy` confirms the printed set matches
  `unblockedTaskNumbers`.
- `bun scripts/prepareTasks.ts --unblocked valid` against the same fixture
  confirms it no longer throws and produces the same `WorkflowArguments`
  JSON shape as `bun scripts/prepareTasks.ts [<same numbers>]`.
- `npx tsc --noEmit` to confirm the new import/export compiles.

Skipped: no new abstraction for "unblocked" beyond the one helper — both
callers read it directly. Add a cached/memoized version only if
`unblockedTaskNumbers` is ever called in a hot loop, which it isn't here.
