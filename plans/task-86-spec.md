# Task 86 — one worktree per task

Agreed design, from the grilling session on 2026-08-07. Supersedes the approach
described in the task 86 record (whose SKILL.md line references are stale — the
pipeline text moved to `scripts/tackleTasksBrief.ts`).

## The shape

Grouping by file overlap is gone. One task, one worktree, one branch.

```
worktree   $TMPDIR/taskTools-wt/<repo>/task-<N>
branch     task-<N>          (same branch name created in every submodule)
```

`skills/tackle-tasks/task.workflow.js` is one file holding all four stages. A
`stage` launch argument selects how much runs, so any stage is still launchable
by hand:

| stage | runs | when |
| --- | --- | --- |
| `plan` | plan → review/fix loop | parallel phase |
| `implement` | implement + fence check | parallel phase |
| `rebase-test` | rebase, conflicts, full suite green | serial tail |
| `merge` | cleanup, merge, close | serial tail |

Default (no `stage`) runs `plan` + `implement` and stops.

## Parallel phase — no barriers

Orchestrator keeps **6** per-task workflows in flight and starts the next one
as soon as any finishes. 6 matches `TASKS_PER_COMMAND` in `scripts/taskStats.ts`.
Nothing waits on anything else.

### stage `plan`

1. Brief written programmatically from tasks.json (`writeTaskBriefFile`).
2. Planner agent writes `plans/task-<N>-plan.md`.
3. Up to **3 rounds** of: `verify` agent (codex review) → `applyFeedback` agent
   applies the FIXES block. Two separate agents, unlike today's single agent.
4. If codex returns `missingFiles`, the **workflow** runs
   `node scripts/addTaskFiles.ts '[N]' <paths>` — plain code, no agent —
   regenerates the brief, and re-runs the planner from scratch via the existing
   `fileRetryPreamble`. Counts as one of the 3 rounds.
5. After 3 rounds, implement regardless of verdict. Unaddressed objections are
   carried forward to the approval gate as proposed tasks.

Requires: `missingFiles: {type: 'array', items: {type: 'string'}}` added to
`VERIFY_SCHEMA`, and codex's prompt asking for repo-relative paths rather than
prose.

### stage `implement`

Implement agent runs `jot:implement`, writes and runs the task's own tests,
commits. Then a **programmatic fence check**:

```
git -C <worktree> diff --name-only <base>..HEAD
```

compared against the task's `files` list. Out-of-bounds paths are reported at
the gate. The fence is checked, not merely stated in a prompt.

Note: `files` is now the task's own list. Today `prepareTasks.ts:172` hands
every task in a group the group's *combined* list, so task A may edit task B's
files. Per-task worktrees fix that.

## The gate — one, at the end

After every task finishes `plan` + `implement`, one `AskUserQuestion` shows:

- per-task status
- fence violations
- leftover codex objections, as proposed tasks — accepted ones go into
  tasks.json through the `create-task` skill, the rest are dropped

Nothing merges before this.

## Serial tail — a retry queue

Tasks queue in order. Each lap, for each task:

1. **Submodule first.** Rebase the submodule's `task-N` branch onto the
   submodule's source tip, merge it there.
2. **Then parent.** Rebase the parent's `task-N` branch onto the source tip,
   resolve the gitlink to the just-merged submodule commit, merge.
3. Conflicts go to the merge agent, fed from `collectConflictedRebasePaths`.
4. Full suite must be green (1199 tests, ~17s), with a fix loop.
5. On success: delete plan + brief, merge, run `scripts/closeTasks.ts`
   directly (no subagent), `removeWorktreeAndBranch`.
6. On any failure: nothing lands, the task goes to the **back of the queue**
   intact.

**Exit condition:** a full lap that merged zero tasks. Nothing changed, so
retrying is byte-identical. Report what's left. Terminates in at most N laps.

The parent never references an unmerged submodule commit.

## Reused vs replaced

Reuse from `scripts/mergeTaskWorktrees.ts`:

| function | step |
| --- | --- |
| `rebaseGroupOntoSource` | 7a |
| `collectConflictedRebasePaths` | 7b |
| `mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts` | 8b |
| `removeWorktreeAndBranch` | cleanup |
| `unmergedCommitCount` | "am I on the tip?" |

Write a **new** merge orchestration from scratch, submodule-aware.
`scripts/runMergePhase.ts` goes, along with `buildMergeOutcomes`,
`coordinateMergeRetry`, `refreshBaseOids`, and the aggregated `stepOutputsFile`
— all built for a batch model that no longer exists. The queue makes base drift
structurally impossible instead of recovering from it.

## Progress display

`meta.name` = `task-<N>`. Phase titles prefixed with the task number
(`86 Plan`, `86 Implement`). Agent labels keep `plan:86` form. Six concurrent
runs stay tellable apart.

## Tests required on the merge orchestration

When this task is split, the child covering the new merge orchestration must
**not** carry `tests: "skip"`. It is the one piece with no safety net and a
history of shipping wrong quietly. Its `tests` field must ask for at least:

- **Queue mechanics.** A task whose rebase or test run fails goes to the back
  of the queue and is retried on the next lap; a lap that merges zero tasks
  ends the queue instead of looping.
- **Submodule ordering.** The submodule's `task-N` branch is merged into the
  submodule's source branch *before* the parent's gitlink bump lands. Assert
  the parent's source branch never points at a commit that exists only on a
  task branch.
- **Failure is atomic.** When any step of a lap fails, nothing lands: no
  partial merge, the worktree and branch survive intact, and the task is still
  open in tasks.json.
- **The tree matches the commit.** After a successful merge, the source
  branch's index and working tree equal the merged commit. This is the task
  119 bug — `git update-ref` advancing a checked-out branch while index and
  working tree stayed at the pre-merge base, which reads as a staged revert.
- **Closing is gated on merging.** `scripts/closeTasks.ts` runs only after the
  merge actually succeeded. A blocked or skipped task must still be open when
  the run ends.

The last two are regressions that have already happened in this repo, not
hypotheticals.

## Risks and open items

- **The risky part:** `basePublication.ts` (250 lines, just fixed by task 119)
  is tangled into `coordinateMergeRetry`. Untangling submodule/multi-repo
  publication from the batch retry machinery without breaking task 119's fix is
  the hard bit of this job.
- `merge.workflow.js` — today the "unblock" workflow launched on a blocked
  merge. Fate undecided.
- `blockers.workflow.js` — assumed unchanged, still runs before task prep.
- `test.workflow.js` disappears as a separate phase; its work splits between
  the implementer's own tests and the tail's full-suite gate.
- `groupTasksByFileOverlap` loses its caller in `prepareTasks.ts`.
  `scripts/taskStats.ts` still uses it for the parallel-commands display.

## Bug found while grilling (independent of this task)

Each phase workflow receives "the pipeline args JSON exactly as printed" — a
snapshot `prepareTasks` froze before planning. So when the planner's file-retry
runs `addTaskFiles.ts`, tasks.json updates and `plan.workflow.js` mutates its
local copy, but **`implement.workflow.js` still gets the old list.** The
widened files never reach the implementer. Fixed for free by one workflow per
task — one process, one live list.
