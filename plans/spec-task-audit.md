# Task 86 spec/task audit

Audited open tasks 145–153, 156, and 157 against `plans/task-86-spec.md` on 2026-08-08.

## Verdict

The task set mostly follows the task-86 design, but several records do not fully match the spec or each other.

| Task | Assessment | Issue |
| --- | --- | --- |
| 145 | Partial match | Conflict handling matches the spec, but its actual `files` array has eight paths even though its user description requires exactly four. |
| 146 | Partial match | Green-gate behavior matches, but `tests: "skip"` leaves the spec's required cross-repository test-discovery coverage unassigned. |
| 147 | Needs clarification | The queue behavior matches, but the description alternately says the Node queue launches workflows and that only the main orchestrator can launch them. |
| 148 | Mostly matches | Early-exit semantics match. Its `tests` field omits the required case where zero merges must not exit while a workflow remains outstanding. |
| 149 | Mostly matches | Reporting matches, but its tests omit “failed first lap, merged second lap.” “2-lap ceiling reached” also needs to be separated from the last concrete failure reason. |
| 150 | Matches | Cleanup location, idempotency, and preservation of implementation notes align. |
| 151 | Matches | Ordered submodule-first merge and deferred worktree removal align. |
| 152 | Partial match | Close/hash/CAS behavior aligns, but the `tests` field omits the required concurrent `tasks.json` rewrite test. |
| 153 | Description matches | Its semantics correctly allow already-merged submodule branches to remain merged. Its title's “no partial merge” wording contradicts that rule. |
| 156 | Does not match final architecture | It targets workflow files that task 157 deletes, while the consolidated workflow already keeps the widened file list live. |
| 157 | Partial match | Correct end-of-chain responsibilities, but its description contradicts its user-requested tests and contains a stale “only referrer” claim. |

## Required corrections

### 1. Task 156 is obsolete or incorrectly scoped

The spec explicitly says the stale-files problem is fixed by the single-workflow architecture (`plans/task-86-spec.md:257-264`). The consolidated workflow already:

- updates `tasks.json`;
- reloads the widened task;
- mutates the live `preparedTask.files` list; and
- passes that same object into implementation.

This behavior is in `skills/tackle-tasks/task.workflow.js:295-311` and `:339-364`.

Task 156 instead modifies `plan.workflow.js`, which task 157 deletes. Task 157 is not blocked by task 156, so the tasks can execute in an impossible order.

Recommendation: mark task 156 obsolete after confirming the future queue never relies on stale `task.files`. If a persisted-arguments refresh is still necessary for `runMergePhase.ts`, rewrite task 156 around that surviving boundary and make task 157 depend on it.

### 2. Task 147 has an actor-boundary contradiction

Task 147 says the merge scheduling queue “launches” `task.workflow.js`, but later correctly says that launching workflows belongs to the main orchestrator. Task 157 also assigns those launches to the orchestrator.

The intended contract should be explicit:

```text
runMergePhase.ts queue chooses the next task and stage
        ↓
main orchestrator launches task.workflow.js
        ↓
orchestrator feeds the stage result back to the queue
```

The Node queue cannot itself invoke the Workflow hook. Task 147 should describe a state-machine/API boundary, not say that it launches workflows.

### 3. Mandatory spec coverage is missing from task test fields

The spec's mandatory merge-orchestration coverage begins at `plans/task-86-spec.md:188`. These required cases are not fully assigned:

- **Cross-repository test discovery:** a submodule with a test configuration distinct from the parent's must have that policy discovered and executed from inside the submodule. Task 146 currently has `tests: "skip"`, and no later test field states this exact case.
- **Outstanding-workflow zero-merge guard:** a zero-merge lap with a workflow still running or awaiting approval must not exit. Task 148 includes this in its prose but omits it from its `tests` field.
- **Concurrent tasks.json writes:** a rewrite between the read and rename must preserve both the archive and the other writer's change. Task 152 includes this in its user description but omits it from its `tests` field.

Add these cases explicitly to the respective `tests` fields so they cannot be lost during planning.

### 4. Task 145's files violate its exact requirement

Task 145's user request requires exactly these four files, in this order:

```json
[
  "plans/task-86-spec.md",
  "skills/tackle-tasks/task.workflow.js",
  "skills/tackle-tasks/merge.workflow.js",
  "scripts/mergeTaskWorktrees.ts"
]
```

The task record additionally contains:

- `scripts/repositoryDiscovery.ts`
- `scripts/repositoryManifest.ts`
- `scripts/repositoryBranches.ts`
- `scripts/resolutionRequests.ts`

Either restore the exact four-file list or revise the exact-list requirement. Leaving both creates an unambiguous internal disagreement and widens the implementation fence beyond the stated task boundary.

### 5. Task 157's test instructions contradict each other

Task 157's user description requires tests asserting that:

- generated instructions launch both `rebase-test` and `merge`;
- generated instructions no longer invoke the `close-tasks` skill; and
- all five superseded workflow files are gone and unreferenced.

Its final description instead says the tests use real worktrees “rather than asserting instruction text,” and its `tests` field contains only end-to-end queue cases.

Task 157 should require both groups:

1. generated-instruction and file-removal assertions; and
2. end-to-end worktree/queue cases.

The task also says `scripts/tackleTasksBrief.ts` is currently the only referrer of the five old workflow files. That claim is stale: the current source references only `blockers.workflow.js` and `task.workflow.js`. There are currently no production-code references to the five files task 157 removes. The deletion remains appropriate, but the factual justification should be corrected.

## Additional record-level corrections

### Task 149

The acceptance criteria require a task that fails its first lap and merges on its second lap to appear only as merged. Its `tests` field does not require that regression case.

The outcome model should also distinguish:

- `lastFailure`: the concrete carried-forward failure, such as an untested layer or unresolved conflict; and
- `terminalReason`: why no further attempt occurred, such as the two-lap ceiling.

Otherwise “report the last attempt's failure” conflicts with treating “2-lap ceiling reached” as the failure reason.

### Task 152

Its implementation description correctly requires compare-and-swap protection for both `tasks.json` and `completedTasks.json`, but its `tests` field only checks the merged hash and blocked-task behavior. Add the concurrent-rewrite test required by both its user description and the spec.

### Task 153

The description matches the spec's three failure positions:

1. before any merge, no source branch moves;
2. during ordered merging, already-merged submodule branches are not rolled back; and
3. after the parent merge, a close failure leaves the merge intact and reports `MERGED BUT NOT CLOSED`.

The title phrase “no partial merge” contradicts point 2. Rename it to describe “nothing further lands after failure” without implying rollback or transactional atomicity across repositories.

## Coverage that does match

- Tasks 145–146 collectively cover the conflict-agent and full-green rebase-test stage described in serial-tail item 4.
- Tasks 147–149 collectively cover the serial retry queue, two-lap ceiling, zero-merge optimization, and terminal reporting.
- Task 150 correctly places idempotent plan/brief deletion in the task branch while retaining implementation notes.
- Task 151 correctly delegates deepest-first submodule and then parent merging to the existing primitive and leaves closing/removal to task 152.
- Task 152 correctly places direct, merge-hash-gated closing before final worktree removal and preserves `MERGED BUT NOT CLOSED` on close failure.
- Task 153's detailed semantics match the spec's definition of “nothing further lands,” including the rule that already-landed submodule merges are not rolled back.
- Task 157 is correctly positioned after task 153 and owns final orchestrator instructions plus deletion of the five superseded workflow files while retaining `blockers.workflow.js` and `task.workflow.js`.

## Bottom line

Tasks 150 and 151 are clean matches. Tasks 145–149 and 152–153 have correct core semantics but need record or test corrections. Task 147 needs a single explicit orchestrator/queue boundary. Task 156 should probably be closed as already resolved or rewritten around a surviving persisted-arguments requirement. Task 157 needs its conflicting test requirements reconciled and its stale referrer claim corrected.
