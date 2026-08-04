# Task 34 Plan: Archive only successfully published tasks

Phase 4 of the recursive repository-discovery redesign. Neither
`scripts/taskArchival.ts` nor `tests/taskArchival.test.ts` exist yet — this
is new-file work, planned from `plans/brief-34.md` alone.

## Goal

A module that, given the outcome of a multi-repo publish run, archives
*only* the tasks whose work was actually and fully published — moving them
from `tasks.json` to `completedTasks.json` with their commit hash(es) — and
leaves every other task open. It must not prompt for a second approval;
task 31's whole-run approval gate already covers finalization/archival.

## Hard requirements from the brief

1. Archival is driven by an **explicit list** of published task numbers —
   never inferred from "no error was recorded."
2. A task touching a repo that was conflicted, skipped, rolled back, or
   only partially published is **never** archived, even if some of its
   other repos succeeded.
3. No second approval prompt — task 31's gate already authorizes this.
4. Archived rows carry commit hash(es) into `completedTasks.json`.

## Pre-implementation investigation (do before writing code)

The brief forbids reading anything but itself for *this planning pass*,
so the exact shapes below are unverified and must be confirmed by the
implementer with a quick grep pass first (ponytail rung 2 — reuse, don't
reinvent):

- `rg -l "completedTasks.json" scripts/ tests/` — find the existing
  read/move/write helper for tasks.json → completedTasks.json (the
  `taskTools:close-tasks` skill already does "move named task numbers
  ... with commit hashes" — reuse that logic/helper rather than
  reimplementing it).
- `rg -l "approval" scripts/` and inspect the task-31 whole-run approval
  gate module (commit `059d952`, "add whole-run approval gate with state
  digest and drift invalidation") to learn the exact shape of the
  approved-run object taskArchival.ts will receive, and confirm it truly
  has already gated archival (so taskArchival.ts must not re-prompt).
- `rg -l "rolled-back|rollback|conflicted|skipped" scripts/` — find
  whatever earlier phase (1-3) of the redesign already models per-repo
  publish outcome, to match its status vocabulary instead of inventing a
  parallel one.

If a reusable "move task to completedTasks.json with commit hash" helper
already exists, taskArchival.ts should call it per task rather than
duplicating file I/O.

## Design

### Types

```ts
type RepoPublishStatus =
  | 'published'
  | 'conflicted'
  | 'skipped'
  | 'rolled-back';

interface RepoPublishResult {
  repoName: string;
  status: RepoPublishStatus;
  commitHash?: string; // present only when status === 'published'
}

interface TaskMergeResult {
  taskNumber: number;
  repos: RepoPublishResult[];
  fullyPublished: boolean; // true iff every repo entry is 'published'
}
```

(Field/type names to be reconciled with whatever the earlier redesign
phases already use, per the investigation step above — don't invent a
second vocabulary for the same concept.)

### Functions

`scripts/taskArchival.ts` exports two small, separable pieces:

1. `summarizeTaskMergeResults(repoResultsByTask): TaskMergeResult[]`
   Pure aggregation: groups raw per-repo publish outcomes by task number,
   and computes `fullyPublished` — true only when every repo the task
   touched reports `status === 'published'`. This is the "return
   task-level merge results after successful publication" half of the
   brief. Skip this function entirely if the earlier phase already
   produces per-task aggregates — don't build a second aggregator for
   data that already exists in the right shape (confirm via the grep
   above before writing it).

2. `archivePublishedTasks(publishedTaskNumbers: number[], mergeResults: TaskMergeResult[]): { archived: number[]; leftOpen: number[] }`
   - Takes the **explicit** list of task numbers the caller has already
     decided are published (never derives it from absence of an error).
   - Defensively cross-checks each number against `mergeResults`: only
     archives a task number if it is both in `publishedTaskNumbers` AND
     its `TaskMergeResult.fullyPublished === true`. Anything else is
     left in `tasks.json` untouched — this is the belt-and-suspenders
     check that stops a partially-published or rolled-back task slipping
     through if the caller's explicit list is ever wrong.
   - For each task to archive, pulls the task's commit hash(es) from its
     `TaskMergeResult.repos` and moves the task from `tasks.json` to
     `completedTasks.json`, recording those hashes (reuse the
     close-tasks move helper if the grep above finds one).
   - Does not prompt, does not call any approval/confirmation code path
     — the whole-run approval already happened upstream (task 31).
   - Returns `{ archived, leftOpen }` for the caller to report/log.

No new dependency, no config object, no plugin/strategy layer — one
aggregation function (only if the data doesn't already exist upstream)
and one filter-and-move function, per ponytail rung 6/7.

## Implementation steps

1. Run the investigation greps above; note in a one-line comment atop
   `taskArchival.ts` which existing helpers are being reused.
2. Write `scripts/taskArchival.ts`:
   - `summarizeTaskMergeResults` (only if not already provided upstream).
   - `archivePublishedTasks` as designed above, reusing the existing
     tasks.json/completedTasks.json move-with-commit-hash helper if one
     exists; otherwise the smallest local read-filter-write over both
     JSON files.
3. Keep the file under the repo's 250-line cap; if the reused-helper
   path and the local-implementation path would both need writing out,
   split before exceeding the cap rather than after.

## Test plan — `tests/taskArchival.test.ts`

Mirror the brief's five scenarios directly, using in-memory/fixture
`tasks.json` + `completedTasks.json` (temp dir, same pattern the existing
`tests/runAuthorization.test.ts` presumably uses — check its fixture
setup and match it rather than inventing a new fixture style):

1. **Partial-repo rollback**: a logical repository rolls back; a task
   that touched it is *not* archived, while a different task whose repos
   all published *is* archived, with its commit hash present in
   `completedTasks.json`.
2. **Conflicted/skipped stay open**: tasks whose merge result includes a
   `conflicted` or `skipped` repo remain in `tasks.json` after
   `archivePublishedTasks` runs, and are absent from `completedTasks.json`.
3. **Explicit-list requirement**: a task with a fully-`published`
   `TaskMergeResult` but whose number is *not* in the
   `publishedTaskNumbers` argument is left open — proving archival
   isn't inferred from clean merge-result data alone.
4. **No second approval prompt**: calling `archivePublishedTasks` invokes
   no confirmation/approval function — assert via a spy/mock on whatever
   approval hook task 31 introduced (or simply assert no such import is
   touched / no stdin prompt fires), confirming task 31's gate is treated
   as sufficient.
5. **Commit hashes land in completedTasks.json**: for each archived task,
   the moved entry in `completedTasks.json` contains the commit hash(es)
   from its `TaskMergeResult.repos`, not placeholder/empty values.

## Edge cases to cover

- A task with zero repos in its merge result (shouldn't happen, but
  `fullyPublished` must default to `false`, not vacuously `true`).
- A task number appearing in `publishedTaskNumbers` but missing from
  `mergeResults` entirely — treat as "leave open," don't throw.
- Duplicate task numbers in `publishedTaskNumbers` — archive once.

## Out of scope

- Any change to how per-repo publish/rollback/conflict status is
  produced (that's an earlier redesign phase).
- Any change to the task-31 approval gate itself.
- A generic "undo archive" path — not requested.

## Open questions for the implementer

- Exact field names/shape of the per-repo publish result from the
  earlier redesign phases, and whether a task-level aggregate already
  exists (resolve via the grep pass before coding; do not guess and
  diverge from the real shape).
- Exact shape/location of the existing tasks.json ⇄ completedTasks.json
  move-with-commit-hash helper (from `taskTools:close-tasks`), if one is
  importable rather than duplicable.
