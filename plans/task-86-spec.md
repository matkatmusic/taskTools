# Task 86 — one worktree per task

**Status: complete.** Task 163 closed this chain — the serial tail launches from the orchestrator's generated instructions and the superseded `*.workflow.js` files are deleted.

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
| `rebase-test` | rebase per layer, conflicts, every layer green | serial tail |
| `merge` | cleanup, merge, close | serial tail |

Default (no `stage`) runs `plan` + `implement` and stops.

## Parallel phase — no barriers

Orchestrator keeps **up to 6** per-task workflows in flight and starts the next
one as soon as any finishes. 6 is a ceiling, never a batch size to fill — the
user may invoke the skill with far more than 6 task numbers, and this is the
guardrail. 6 matches `TASKS_PER_COMMAND` in `scripts/taskStats.ts`.
Nothing waits on anything else.

Each `task.workflow.js` is launched as a **background** workflow, so the call
returns immediately and its completion sends a task-notification back to the
orchestrator. That notification is how the orchestrator learns a task is ready,
with no polling — and it is what makes the per-task gate below possible.

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

A fence violation **never undoes work**. The check does not revert, reset,
checkout, stash, amend, or re-run the implementer. The commit and worktree are
left exactly as the implementer left them; deciding what to do belongs to the
gate.

`jot:implement`'s notes are written to `plans/task-<N>-implementation-notes.md`
and **staged into the task's commit** alongside the owned files, so they land
with the merge and survive in git history. That path is exempt from the fence —
it is expected output, not a violation. `git add -A` / `git add .` stay
forbidden. `WORKER_SCHEMA` gains a `notesFile` string.

Note: `files` is now the task's own list. Today `prepareTasks.ts:172` hands
every task in a group the group's *combined* list, so task A may edit task B's
files. Per-task worktrees fix that.

## The gate — one per task, as that task finishes

When a task finishes `plan` + `implement`, the orchestrator gates **that task
immediately**, without waiting for any other task. One `AskUserQuestion` per
task shows:

- that task's status
- its fence violations
- its leftover codex objections, as proposed tasks — accepted ones go into
  tasks.json through the `create-task` skill, the rest are dropped

An approved task enters the merge queue at once, while other tasks are still
planning or implementing. A task never merges before it has been approved.

The gate is asked by the **main orchestrator conversation**. `AskUserQuestion`
is not a workflow-script hook and is stripped from every subagent, so nothing
else in this pipeline can ask the user anything.

## Serial tail — a retry queue

Approved tasks enter the queue as they arrive and merge **serially**, one at a
time, because every merge moves the tip the next task rebases onto. Each lap,
for each task:

1. **Rebase every submodule layer first**, deepest-first, onto each submodule's
   own source tip. Recurse through all layers, not just the first.
2. After a layer rebases cleanly, **run that layer's tests**.
3. **Then the parent.** Rebase the parent's `task-N` branch onto the source tip
   and resolve the gitlinks to the rebased submodule commits. Then run the
   parent's tests.
4. Conflicts go to the merge agent, fed from `collectConflictedRebasePaths`.
   A red layer goes to a fix agent scoped to that layer, bounded by its own
   `MAX_REBASE_FIX_ROUNDS` — *not* the implementer's `MAX_FIX_ROUNDS`.
5. **Only once every layer is green**, merge: each submodule's `task-N` branch
   into its own source branch deepest-first, then the parent's. Nothing merges
   untested.
6. On success: delete plan + brief (keeping the implementation notes), merge,
   run `scripts/closeTasks.ts` directly (no subagent), and
   `removeWorktreeAndBranch` **last**, so any earlier failure leaves the
   worktree for inspection.
7. On any failure: nothing further lands, and the task goes to the **back of
   the queue** intact.

**One rule governs all rebase testing:** when a submodule changes, every layer
is tested. No per-layer green flags, no dirty marking, no staleness
bookkeeping. A layer's suite running more than once is expected.

Each repository's test command is discovered by calling `discoverTestPolicy`
(`scripts/testPolicy.ts:64`) inside that repository's own directory. A repo
returning `no-test-configuration` is **UNTESTED**, and untested is not green.

**Termination:** a task gets **at most 2 laps**. A task that fails its second
lap leaves the queue unmerged and is reported. The ceiling is fixed and does
not scale with queue size — a "retry until a lap merges nothing" rule would let
one broken task burn 19 laps in a 20-task run.

As an optimisation on top of that ceiling, a lap that merged **zero** tasks
ends the queue early — the tip never moved, so the next lap would be
byte-identical. That early exit applies only when no task workflow is still
outstanding; an empty queue mid-run means "nothing to do yet", not "nothing
left to do".

**An unmerged task is reported with two fields, not one.** "What went wrong" and
"why nothing further was tried" are different questions, and one field cannot
answer both.

| field | holds | carried forward? |
| --- | --- | --- |
| `lastFailure` | the concrete failure of the task's last attempt — rebase conflict, unresolved merge conflict, a layer still red after `MAX_REBASE_FIX_ROUNDS`, an UNTESTED layer, or a cleanup / merge / close failure | yes — from the attempt that produced it, never re-derived afterwards from repository state |
| `terminalReason` | why no further attempt happened — the 2-lap ceiling reached, or the zero-merge lap ending the queue while the task was still retryable | no — it is a property of the loop, not of any attempt |

Both are populated for every unmerged task. A task that failed its second lap on
an unresolved conflict reports that conflict as `lastFailure` **and** the ceiling
as `terminalReason`. Neither field substitutes for the other.

The parent never references an unmerged submodule commit.

**"Nothing lands" means a source branch never moved.** Only a merge moves a
source branch. Fix commits made by the conflict and fix agents live on `task-N`
branches, are not landings, are never undone, and survive for the next lap.
Submodule source branches that already merged before a failure are **not**
rolled back — "nothing further lands" bounds what moves next, it does not
reverse what already moved.

## Reused vs replaced

Reuse from `scripts/mergeTaskWorktrees.ts`:

| function | step |
| --- | --- |
| `rebaseGroupOntoSource` | serial-tail steps 1 and 3 |
| `collectConflictedRebasePaths` | serial-tail step 4 |
| `mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`, `resolveGitlinkConflicts` | serial-tail step 5 |
| `removeWorktreeAndBranch` | serial-tail step 6, cleanup |
| `unmergedCommitCount` | "am I on the tip?" |

Write a **new** merge orchestration from scratch, submodule-aware, **inside**
`scripts/runMergePhase.ts`. "From scratch" describes the design owing nothing to
the old one; it does not mean emptying the file. `buildMergeOutcomes`,
`coordinateMergeRetry`, `refreshBaseOids`, and the aggregated `stepOutputsFile`
plumbing were all built for a batch model that no longer exists, and the queue
makes base drift structurally impossible instead of recovering from it — so they
are **commented out in place** under `// RETIRED (task 147): ...` headers, never
deleted. `resolveStepOutputsPath` in `scripts/prepareTasks.ts` and its callers
stay untouched.

**Retired code is commented out; only whole superseded files are removed, and
only by the end-of-chain task.** That applies everywhere in this chain.

## Progress display

`meta.name` = `task-<N>`. Phase titles prefixed with the task number
(`86 Plan`, `86 Implement`). Agent labels keep `plan:86` form. Up to six concurrent
runs stay tellable apart.

## Tests required on the merge orchestration

When this task is split, the child covering the new merge orchestration must
**not** carry `tests: "skip"`. It is the one piece with no safety net and a
history of shipping wrong quietly. Its `tests` field must ask for at least:

- **Queue mechanics.** A task whose rebase or test run fails goes to the back
  of the queue and is retried on the next lap; a task that fails its **second**
  lap leaves the queue unmerged; a lap that merges zero tasks with no task
  workflow outstanding ends the queue, while a zero-merge lap with a workflow
  still outstanding does not.
- **Both report fields, never one.** A task that failed its second lap on an
  unresolved conflict reports that conflict as `lastFailure` and the ceiling as
  `terminalReason`. A task still retryable when a zero-merge lap ended the queue
  reports its own concrete `lastFailure` with `terminalReason` naming the queue
  exit, not the ceiling.
- **Cross-repo test discovery.** A submodule with its own test configuration,
  distinct from the parent's, has that configuration found and run by
  `discoverTestPolicy` from inside the submodule. Nothing exercises test
  discovery below the root repository today.
- **No dangling gitlinks.** After a successful merge, delete every `task-N`
  branch and assert the parent's source branch still resolves — every submodule
  commit its gitlinks point at is reachable from that submodule's *source*
  branch.
- **Implementation notes survive.** After the merge,
  `plans/task-<N>-implementation-notes.md` exists in the source branch's tree,
  while `plans/task-<N>-plan.md` and `plans/brief-<N>.md` do not.
- **Concurrent tasks.json writes.** A rewrite of tasks.json between the read
  and the rename loses neither the archive nor the other writer's change.
- **Submodule ordering.** The submodule's `task-N` branch is merged into the
  submodule's source branch *before* the parent's gitlink bump lands. Assert
  the parent's source branch never points at a commit that exists only on a
  task branch.
- **Failure is atomic, and "atomic" means three different things depending on
  where the lap failed.** In every case the worktree and its `task-N` branch
  survive intact and the task is still open in tasks.json.
  - *Before any merge* — a rebase, conflict, test or cleanup failure moves no
    source branch at any layer: `git rev-parse` of the parent's source branch
    returns exactly the hash it returned before that lap began.
  - *During the ordered merge* — submodule source branches that already merged
    before a later layer fails stay merged and are never rolled back. The
    parent's source branch is unchanged until its own merge succeeds.
  - *After the parent merge* — a **close** failure does **not** unwind the
    merge. The parent's source branch legitimately carries it, and the run
    reports MERGED BUT NOT CLOSED with that hash. Asserting an unchanged parent
    hash for this case is wrong.
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
- `merge.workflow.js` — was the "unblock" workflow launched on a blocked
  merge. Whatever remained useful in its conflict-fixing prompt was folded
  into the `rebase-test` stage (task 145). Task 163, the end of the chain,
  deleted it along with the other superseded `*.workflow.js` files.
- `blockers.workflow.js` — assumed unchanged, still runs before task prep.
- `test.workflow.js` disappeared as a separate phase; its work split between
  the implementer's own tests and the tail's full-suite gate. Task 163
  deleted it.
- `groupTasksByFileOverlap` loses its caller in `prepareTasks.ts`.
  `scripts/taskStats.ts` still uses it for the parallel-commands display.

## Bug found while grilling (independent of this task)

Each phase workflow receives "the pipeline args JSON exactly as printed" — a
snapshot `prepareTasks` froze before planning. So when the planner's file-retry
runs `addTaskFiles.ts`, tasks.json updates and `plan.workflow.js` mutates its
local copy, but **`implement.workflow.js` still gets the old list.** The
widened files never reach the implementer. Fixed for free by one workflow per
task — one process, one live list.

Task 162 predated that fix and was reassessed before `plan.workflow.js` was
deleted, rather than assumed dead. **Done.** The reassessment found the planning
half already fixed — `skills/tackle-tasks/task.workflow.js` re-reads `tasks.json`
at every stage — but a narrower bug surviving: `.taskTools/run-arguments.json`
stayed stale after a mid-run fence widening, and `scripts/mergePipeline.ts` reads
that snapshot to verify a task's code landed before archiving it. Task 162 was
retargeted to that, and `scripts/addTaskFiles.ts` now refreshes the snapshot
whenever it widens a fence.
