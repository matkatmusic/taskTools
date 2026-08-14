# Phase 10 remediation feedback — iteration 1

Review target: staged tree `5c074de299e3e8b314636ec578b06dbe26fc0fff`.

Only the following findings from `plans/phase10-audit.md` remain unresolved. The implementation
changes for the other findings and the full test suite are green.

## Finding 1 remains unresolved: the required real retained-lease workflow test is missing

The workflow now calls `isTaskRunResumable` before writing to every existing worktree, and the
unit tests prove that `isTaskRunResumable` transfers both lease records. However, the audit
required one real workflow test that starts with an ended run's safe retained worktree and old
physical lease, proves the newly claimed run owns both records before `updateTaskDocs`, and then
executes real cleanup without an owner mismatch.

`test_workflow_establishesTheLeaseBeforeWritingToASafeExistingWorktree` in
`tests/tackle-tasks/workflowBehavior.test.ts` uses the workflow mock harness. Its mocked
`isTaskRunResumable` result does not adopt either lease, and its mocked `cleanupTaskWorktree`
cannot expose the owner-mismatch failure that caused this finding. The separate
`isTaskRunResumable` unit tests prove lease transfer but do not connect that transfer to workflow
ordering and cleanup. Thus no test currently proves the complete acceptance path.

Add the prescribed integration test using a real linked task worktree, task/run records, and
physical lease. Begin with an ended old run retaining a structurally safe worktree; claim a new
run through the Phase 10 workflow; observe immediately before the real `updateTaskDocs` call that
both `task.run.leaseRunId` and `<worktree>.lease` name the new run; allow the workflow to finish;
and assert real cleanup succeeds, releases ownership/source locking, and does not produce an
owner-mismatch or `run-failed` result. Keep the current unit and dispatch-order tests as narrower
coverage.

## Finding 6 remains unresolved: emitted edit-path existence is not tested

The emitter now derives disjoint created/pre-existing categories and maps occurrence-tagged test
identities to absolute checkout paths. But the audit explicitly required proving that every
emitted edit path exists in its intended checkout.

The new tests create a real root worktree and child submodule, but they never create
`tests/created.test.ts`, `tests/modified.test.ts`, `tests/root.test.ts`, or
`child/tests/child.test.ts`. The nested test computes `expectedPath` and asserts that its string
appears in the prompt; despite the comment saying the path is “directly openable,” it never calls
`existsSync(expectedPath)` or reads the file. The root test has the same gap. A string-joining
regression can therefore satisfy these tests while emitting a nonexistent edit target.

Extend the real worktree fixture/test setup to create one new root test, one modified root test,
and one new child-occurrence test at the exact paths supplied to `amendTestsPrompt`. Extract or
otherwise identify every absolute edit path emitted in both categories, then assert each exists,
is a regular file, resolves within the expected root or child checkout, and can be opened from
that path. Preserve the assertions that the created and pre-existing categories are disjoint.

## Verification

- Frozen staged tree: `5c074de299e3e8b314636ec578b06dbe26fc0fff`.
- `git diff --cached --check` — passed.
- Phase 10 targeted remediation tests — 137 passed, 0 failed.
- Monitor tests — 11 passed, 0 failed.
- `npx tsc --noEmit` — passed.
- `npm test` — 1,875 passed, 0 failed.
