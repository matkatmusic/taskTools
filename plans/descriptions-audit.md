# Description audit: tasks 145–153

Audit scope: `.taskTools/tasks.json` tasks 145 through 153, checked as one dependency chain against `plans/task-86-spec.md` and the current referenced implementation files.

No task descriptions or source files were changed as part of this audit.

## Critical conflicts

### 1. Task 153's failure contract is impossible as written

Task 153 says that failure of any step—including merge or close—leaves every source branch unchanged and the repository "exactly as it was." That conflicts with:

- the task 86 spec, which explicitly permits already-merged submodules to remain merged after a later failure;
- task 144's ordered, non-rollback merge behavior; and
- task 152, which says a successful merge is not unwound if closing fails and the result must be reported as `MERGED BUT NOT CLOSED`.

Task 153 also says the task branch remains "untouched," while its own `userDescription` and the spec say conflict-agent and fix-agent commits remain on that branch for the next lap.

The contract needs to distinguish three points in the lap:

1. Before merging, no source branch moves.
2. During ordered merging, already-merged submodules remain merged if a later layer fails, but the parent remains unchanged until its own merge succeeds.
3. After the parent merges, a close failure does not unwind the merge; the task stays open and the worktree remains.

Relevant locations:

- `.taskTools/tasks.json`, task 153, starting at line 696.
- `plans/task-86-spec.md`, especially lines 148–155 and 209–220.

### 2. No task owns production orchestration of the queue

Tasks 147–149 put the queue in `scripts/runMergePhase.ts`, but only the main orchestrator can:

- receive background workflow notifications;
- ask the per-task approval question;
- know whether workflows are still outstanding; and
- launch the `rebase-test` and `merge` workflow stages as approvals arrive.

The current generated tackle-tasks instructions stop after saying an approved task "enters the merge queue." They never launch those stages or call the new queue. They also still instruct the orchestrator to use the old `close-tasks` skill at the end, contradicting task 152's direct closure design.

No task from 145 through 153 owns `scripts/tackleTasksBrief.ts` or `tests/tackleTasksBrief.test.ts`. The chain needs either:

- an explicit event/API boundary through which `runMergePhase.ts` receives approvals and outstanding-workflow state; or
- an orchestrator change that directly owns the queue and launches the workflow stages.

Relevant locations:

- `scripts/tackleTasksBrief.ts`, lines 91–124.
- `plans/task-86-spec.md`, lines 29–40 and 86–102.

### 3. Task 147 bypasses the merge stage completed by tasks 150–152

Task 147 says its queue directly calls the task-144 merge primitive. Tasks 150–152 later put cleanup, merging, closing, and worktree removal into `task.workflow.js`'s `merge` stage.

Nothing later changes `scripts/runMergePhase.ts`, so the queue can continue calling the primitive directly and bypass:

- task 150's plan/brief cleanup;
- task 152's verified close; and
- final worktree removal.

Task 147 should call the complete merge stage, or tasks 150–152 must explicitly update the queue. The current division does neither.

### 4. Task 145 expects a live conflict that the current primitive removes

`rebaseGroupOntoSource` collects conflicted paths, aborts the rebase, and only then returns the conflict outcome. Task 145 says it consumes that conflict output but does not rebase. Therefore the agent receives the correct path names but no in-progress conflict to resolve.

The chain must specify one of these behaviors:

- preserve the in-progress rebase for task 145; or
- have task 145 recreate and continue the rebase.

That likely requires `scripts/mergeTaskWorktrees.ts` in task 145's access list.

Relevant location: `scripts/mergeTaskWorktrees.ts`, lines 165–186.

### 5. Task 146 describes two incompatible test gates

Task 146's `userDescription` and the spec require:

- per-layer results;
- each repository's own `discoverTestPolicy` result;
- a fix agent scoped to the red layer;
- re-running that layer; and
- `no-test-configuration` counting as untested, not green.

Its canonical `description` instead mandates one hard-coded root command:

```text
node --test "tests/**/*.test.ts"
```

That ignores repositories with different test commands and contradicts the cross-repository design in `plans/task-86-spec.md`, lines 129–135. It also never says the fix agent's edits must be committed, although the spec requires fix commits to survive on `task-N` branches.

### 6. Tasks 147 and 148 disagree about whether a first failure gets retried

Task 147's acceptance test says a failed task is retried on the next lap. Task 148 says that if every task fails and no workflow remains outstanding, the zero-merge rule ends the queue after exactly one lap.

Both can be valid only if task 147's retry test explicitly includes another successful merge or an outstanding workflow. The chain-level statement that "a failing task gets one more lap" is otherwise false: it gets another lap only if the zero-merge optimization does not fire.

There is also stale text saying task 147 installs a placeholder hard cap, while its canonical description says it installs the permanent per-task two-lap ceiling.

### 7. Task 149 cannot report all eventual failure outcomes

Task 149's canonical description lists only:

- rebase conflict;
- unresolved merge conflict; and
- full-suite failure.

Its `userDescription` additionally lists untested layers and the two-lap ceiling. Tasks 150–153 later add cleanup, merge, close, and potentially worktree-removal failures, but none says it extends task 149's report.

There are two additional bookkeeping gaps:

- A task removed from the queue after its second failure must remain in a terminal-failures collection. Iterating only "tasks still in the queue" will miss it.
- Task 152 requires `MERGED BUT NOT CLOSED`, which is not an unmerged outcome and has no defined reporting owner.

## `files[]` inconsistencies

### Embedded exact-list instructions disagree with the actual arrays

The embedded instruction that the `files` field must contain an exact list disagrees with the actual `files[]` in five tasks:

| Task | File present in actual `files[]` but absent from the embedded exact list |
| --- | --- |
| 146 | `plans/task-86-spec.md` |
| 150 | `skills/tackle-tasks/task.workflow.js` |
| 151 | `skills/tackle-tasks/task.workflow.js` |
| 152 | `skills/tackle-tasks/task.workflow.js` |
| 153 | `skills/tackle-tasks/task.workflow.js` |

The actual additions mostly look necessary. The stale exact-list text should be aligned with the actual required access rather than removing those files.

### Referenced or required files are missing from access

- **Task 145:** Explicitly tells the planner to find `collectConflictedRebasePaths` in `scripts/mergeTaskWorktrees.ts`, but that file is absent.
- **Task 146:** References `skills/tackle-tasks/implement.workflow.js`. More importantly, implementing the per-layer contract requires understanding the result types in `scripts/mergeTaskWorktrees.ts`.
- **Task 147:** Removing the aggregated `stepOutputsFile` plumbing also requires changes currently present in `scripts/prepareTasks.ts`, `scripts/mergePipeline.ts`, and `tests/mergeTaskWorktrees.test.ts`. Those files still define, emit, import, clean up, or test the old artifacts.
- **Task 151:** Explicitly says to fix `scripts/mergeTaskWorktrees.ts` if the primitive is incomplete, but that file is absent.
- **Task 152:** Calls `removeWorktreeAndBranch` by name but cannot inspect its defining file, `scripts/mergeTaskWorktrees.ts`.
- **Tasks 152 and 153:** Both require substantive tests, but neither owns any test file. `tests/closeTasks.test.ts` already exists and is not listed.

## Missing acceptance coverage and edge contracts

### Implementation notes are not tested through the final merge

Task 150 says `tests: "skip"`, and no later task explicitly tests that:

- `plans/task-<N>-implementation-notes.md` survives in the source branch;
- `plans/task-<N>-plan.md` is absent; and
- `plans/brief-<N>.md` is absent.

The spec explicitly requires this regression test.

### Task 150 cleanup has no retry/idempotency contract

If cleanup commits successfully on the task branch but merging fails, the next lap encounters plan and brief files that are already deleted. Task 150 does not say whether cleanup is an idempotent no-op in that state or how it avoids an empty-commit failure.

### Task 152's concurrent-write design protects only one of two files

The requested compare-and-swap sequence is defined only for `tasks.json`. Closing moves data across both `tasks.json` and `completedTasks.json`. Concurrency, write ordering, and recovery for the second file are unspecified, so the promise that neither the archive nor another writer's change is lost is incomplete.

The current implementation writes the two files separately in `scripts/closeTasks.ts`, lines 78–83.

### Failure of final worktree removal is unclassified

Task 152 places `removeWorktreeAndBranch` after successful closure. If that final call fails, the task is already archived but the promised cleanup is incomplete. No task defines whether this is a warning, retryable cleanup state, or a distinct report outcome.

### Superseded workflow deletion has no consistent owner

The spec says deletion of `merge.workflow.js` and the other superseded workflow files happens at the end of the chain. Task 145 contains conflicting instructions:

- its top-level goal says deleting `merge.workflow.js` is not part of task 145; but
- its embedded split description and canonical description say to delete it immediately.

No end-of-chain task owns deletion of all the other superseded workflow files. Relevant spec text is in `plans/task-86-spec.md`, lines 231–238.

## Recommended correction order

Before implementation starts at task 145:

1. Reconcile task 153 with the permitted partial submodule merge and post-merge close-failure semantics.
2. Define the orchestrator/queue event boundary and assign `scripts/tackleTasksBrief.ts` plus its tests to an appropriate task.
3. Decide whether task 147 calls the complete merge stage or whether tasks 150–152 extend its queue explicitly.
4. Define whether rebase conflicts remain live or are recreated before the task-145 agent resolves them.
5. Replace task 146's hard-coded root-suite language with the per-layer `discoverTestPolicy` contract.
6. Make the retry statements conditional on the zero-merge rule and remove stale placeholder-cap language.
7. Expand task 149's outcome model to include terminal failures and `MERGED BUT NOT CLOSED`.
8. Align every embedded exact-list instruction with the actual `files[]`, add omitted implementation/test files, and assign the missing regression tests.
