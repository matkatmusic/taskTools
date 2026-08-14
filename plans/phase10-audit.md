# Phase 10 audit

Review target: staged tree `af196b96125d25938ab75586f10618561b705f1c`, compared with
Phase 10 of `plans/tackle-tasks-v1_5-plan.md`, the Phase 8 transition/reconciliation
contracts, `plans/workflow-only-context-injection.md`, and
`plans/diagram/pipeline.mmd`.

## Findings

### 1. The safe-existing-worktree path never adopts the retained lease

The retained-work policy requires the next claimed run to adopt the prior ended run's
worktree lease before doing new work. `runWorktree()` instead returns directly from
`checkTaskWorktreeSafe` to `refreshDocs()` when `safe:true`
(`skills/tackle-tasks/tackle-tasks.workflow.js:405-407`). The only dispatched operation
that establishes ownership is `isTaskRunResumable`, and that is called only on the
`safe:false` edge (`:409-411`). `claimTaskRun` does not transfer the lease.

This is a normal recovery state, not a speculative race: failed cleanup deliberately retains
the ended run's lease while its worktree or branch remains. A later claim can therefore accept
and modify a structurally safe worktree while the physical lease and `task.run.leaseRunId`
still name the old run. On success, `cleanupTaskWorktree` deletes the worktree and branches and
then calls `releaseTaskWorktreeLease` with the new run ID; the owner mismatch throws after the
destructive removals and before the source lock is released
(`scripts/tackle-tasks/cleanupTaskWorktree.ts:88-111`). The task can be merged but converted to
`run-failed`, with stale ownership and lock state left behind.

Add an explicit, reconciled lease-establishment mutation for every existing-worktree path after
claim and before docs/planning, whether the worktree is structurally safe or needs the
resumability decision. It must atomically adopt an ended owner's lease or acquire an absent one,
and refuse an unproved owner mismatch. Do not hide the mutation in a read-only box. Add a real
workflow test beginning with an ended run, a safe retained worktree, and its old lease; prove the
new run owns both lease records before `updateTaskDocs`, then completes cleanup without an owner
mismatch.

### 2. A lost result from the proved-safe rerun is never reconciled

`runMutatingScript()` correctly reconciles the first null result and reruns only after
`not-completed`, but if that rerun also returns null it immediately returns null
(`skills/tackle-tasks/tackle-tasks.workflow.js:285-298`). The caller then selects
`run-failed`. That second null has exactly the same ambiguity as the first: the rerun may have
completed the mutation before its result was lost, so Phase 8 and diagram rule 11 require
another read-only reconciliation before choosing an edge.

A controlled execution reproduced the unsafe case at the claim box: the first claim returned
null without landing, reconciliation returned `not-completed`, the same-step rerun landed the
claim but returned null, and the workflow stopped with
`{exitType:"run-failed", chainRan:false}` after only one reconciliation. The task is then
actually claimed but the workflow believes no claim exists, so it skips the exit chain and
strands `active:true`.

Reconcile every lost dispatch result, including the proved-safe rerun, with the same `stepId`.
After the rerun, accept `completed` and its reconstructed result, use an `ambiguous` verdict's
exact note for `run-failed`, and rerun no further time when the second verdict is
`not-completed`. Add a workflow-level fault-injection test for the reproduced claim sequence and
at least one post-claim mutation; assert two reconciliations, no third mutation attempt, and the
normal completed edge when the second reconciliation observes the landed mutation.

### 3. Yellow-box mutations are blindly executed up to three times

The Phase 10 `runRole` form is a single `agent()` call. Only read-only scripts use the
three-attempt null guard; mutating green scripts use reconciliation. The implementation instead
wraps every role in `retryAgent()` (`skills/tackle-tasks/tackle-tasks.workflow.js:301-302`).
That includes `implement`, `fix-tests`, `fix-suite`, `fix-conflicts`, and `amend-tests`, all of
which edit the worktree, as well as roles that write plan/review artifacts. A lost return after
one of those agents edits successfully causes the same mutation prompt to run up to two more
times with no receipt or state check. Reapplying a plan, conflict resolution, or test amendment
can overwrite or compound valid work.

Dispatch each yellow box once as specified. A null/failed role result should enter the applicable
`run-failed` path, not respawn the mutating role. Add a behavior test that makes `implement` edit
or records an invocation and return null, then proves it was called exactly once and the claimed
run was finalized through the exit chain. Cover at least one repair role as well so the blanket
retry helper cannot be reintroduced around `runRole`.

### 4. Operational script/agent errors can bypass the mandatory exit chain

Diagram rule 10 requires a non-zero script exit to become `run-failed`, with the script's stderr
as the exit note and the appropriate pre-claim/claimed/post-inactivation cleanup behavior.
Neither dispatch helper catches a rejected `agent()` call
(`skills/tackle-tasks/tackle-tasks.workflow.js:275-302`), and the prompts/schema expose only the
success JSON. Thus an agent rejection caused by a non-zero Bash command rejects the entire
workflow instead of calling `failRun`. If the harness normalizes that failure to null instead,
the workflow records only generic text such as "the commit box produced no result", losing the
required stderr and making an operational failure indistinguishable from lost stdout.

Make dispatch return a typed success/lost-result/operational-error outcome (or catch the actual
workflow-agent rejection equivalently). Thread operational stderr into `failRun` immediately;
only the lost-result outcome may use the null reconciliation policy. Preserve the four rule-10
exit-chain cases. Add behavior tests that reject a read-only box and a mutating box with a
sentinel stderr message, both before and after claim, and prove the workflow result plus stored
exit note contain that exact sentinel and release the applicable holds.

### 5. The plan-scrap counter exits on the third scrap, not the second

Phase 8 says plan scraps are counted before the cap check: increment, then exit when the count
reaches two. `scrapPlan()` checks `planScraps >= 2` before incrementing
(`skills/tackle-tasks/tackle-tasks.workflow.js:435-441`). Consequently the workflow runs the
planner three times and exits only after the third invalid/scrapped outcome. A controlled mock
run produced `plans:3` with exit note "codex scrapped the plan twice". This contradicts both the
diagram's second-scrap exit and the note recorded to task history.

Increment first and exit when the new count is at least `MAX_REPAIR_ATTEMPTS`; only the first
scrap may feed `scrapNotes` back into one replan. Replace the substring-only counter assertion
with a behavior test that returns two invalid plans (and separately two `scrap` reviews), proves
exactly two planner visits, and proves the second event enters `plan-scrapped` without a third
visit.

### 6. The amend-tests payload mislabels created tests as pre-existing and cannot address nested occurrences

`runTaskTests` defines `testFiles` as all runnable changed tests and `createdTestFiles` as a
subset; its own tests pin, for example, `testFiles = [existing, new]` and
`createdTestFiles = [new]`. The workflow forwards both arrays unchanged to `amend-tests`
(`skills/tackle-tasks/tackle-tasks.workflow.js:550-553`). The prompt then declares every entry
in `TEST_FILES` to be a pre-existing test subject to the broken-or-assertion-free restriction,
so every created test is simultaneously described as freely editable and restricted.

The arrays are also occurrence-tagged (`child::tests/child.test.ts` for a submodule), while the
amend prompt presents them as filesystem paths under the root worktree without translating or
explaining the occurrence namespace. An agent cannot reliably open that path, so a flagged test
in a nested occurrence may never be amended.

Pass `testFiles` minus `createdTestFiles` as the pre-existing list, and have the read-only prompt
emitter resolve each occurrence-tagged value to an unambiguous absolute worktree path (while
retaining the display identity if useful). Add workflow/emitter integration tests with one new
root test, one modified root test, and one new nested-occurrence test; prove the categories are
disjoint and every emitted edit path exists in the intended checkout.

### 7. Preflight collapses the partial-close and closing-claim diagnostics

Phase 2 requires `open:false, closeInProgress:true` to exit `not-open` with a note naming the
partial close so a human can finish it. The workflow ignores `closeInProgress` and always says
"task is already completed" (`skills/tackle-tasks/tackle-tasks.workflow.js:353-355`). It also
maps both `claim.status === 'refused'` and `claim.status === 'closing'` to "a previous run left
the claim held" (`:357-361`), although the plan requires the closing note to say the task is
being archived. Neither description is true for its collapsed state, and the first one hides a
recoverable both-files archive transition.

Branch on these fields and preserve the specified distinct notes while retaining the same
non-mutating exit types. Add behavior tests for the both-files `closeInProgress` result and the
tasks-only completed/`closing` claim result, asserting that no exit-chain script runs and the
returned notes identify partial close versus archival closing correctly.

## Verification performed

- Frozen staged tree: `af196b96125d25938ab75586f10618561b705f1c`.
- `git diff --cached --check` — passed.
- `node --test tests/tackle-tasks/workflowStructure.test.ts` — 6 passed.
- `node --test tests/tackle-tasks/greenBoxPolicy.test.ts tests/tackle-tasks/reconcileStep.test.ts`
  — 53 passed.
- `node --test tests/tackle-tasks/AgentPromptEmitter.test.ts` — 48 passed.
- `npm test` — 1,847 passed, 0 failed.
- Controlled workflow execution for repeated invalid plans — reproduced three planner calls
  before the second-scrap exit note.
- Controlled lost-result execution at `claimTaskRun` — reproduced two mutations, one
  reconciliation, a landed claim, and a pre-claim `run-failed` result.

The green suite does not resolve these findings because the new Phase 10 tests inspect source
structure and string presence, while the current workflow's prior behavior tests were redirected
to `skills/tackle-tasks-v1_1/tackle-tasks.workflow.js`.
