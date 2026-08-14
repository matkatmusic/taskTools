# Phase 12 remediation feedback — iteration 1

Review target: frozen tree `b6c2690acd56ca13272e78c7a90556d8bec965f1`.

Only the following parts of findings 1 and 4 from `plans/phase12-audit.md` remain unresolved.
The other findings and acceptance paths are resolved, and the focused and full suites are green.

## Finding 1 remains unresolved: a warm held source lock takes the wrong transition

The audit required the agentless driver to implement the specified source-lock handling. Phase
10 says `lock:"held"` from `rebaseTaskWorktree` logs the holder and re-enters the rebase box;
only `lock:"recoverable"` takes the ordinary `run-failed` exit. The remediated driver instead
maps every non-`acquired` result to `run-failed`
(`tests/tackle-tasks/pipeline.e2e.test.ts:518-525`). None of the new scenarios supplies a warm
competing lock, so this incorrect branch stays green. A normal concurrent task holding the lock
would therefore be reported as a failed run rather than waited out, contrary to the diagram's
serialization policy.

Branch on the lock result exactly as specified: `held` must re-enter `RB` without running the exit
chain, `recoverable` must use `run-failed` with the stale owner's diagnostic, and `acquired` may
advance. Add an end-to-end scenario that acquires a real warm source lock under another owner,
lets the first real `rebaseTaskWorktree` call observe `held`, releases that owner through a
deterministic test callback/barrier, and proves the next real rebase visit acquires the lock and
the run completes. Assert at least two `rebaseTaskWorktree` visits and that no exit-chain box ran
for the temporary held result.

## Finding 4 remains unresolved: the resume test never asserts that the prior work is resumable

The audit explicitly required the resumed-run scenario to assert `resumable:true`. The new test
does prove both lease records were adopted and that cleanup/archive finish, but `runPipeline`
keeps the `isTaskRunResumable` result local (`tests/tackle-tasks/pipeline.e2e.test.ts:395-405`),
and the test asserts only that the box was visited and the leases changed (`:1115-1155`). Because
the worktree is structurally safe, the driver enters `updateTaskDocs` even if
`isTaskRunResumable` incorrectly returns `resumable:false`; the test would still pass. That leaves
the decision which protects resumable work on the unsafe-worktree branch unproved.

Expose the observed resumability verdict to the scenario (for example through the existing
pre-update hook or the pipeline outcome) and assert it is exactly `true` before `updateTaskDocs`.
Keep the existing task-state lease, physical lease, full cleanup, and completed-archive
assertions.

## Verification

- Frozen remediation tree: `b6c2690acd56ca13272e78c7a90556d8bec965f1`.
- `git diff --cached --check` — passed.
- `node --test tests/tackle-tasks/pipeline.e2e.test.ts` — all 12 named Phase 12 tests passed.
- `npx tsc --noEmit` — passed.
- `npm test 2>&1 | rg -e '^✖' || echo "all passing"` — reported `all passing`.
