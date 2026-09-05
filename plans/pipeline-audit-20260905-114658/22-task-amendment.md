# Amendment: Task 22 plan — FIX_CONFLICTS returns the packet answer protocol; COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED verifies it against live git state

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/22-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/22.json and the live tackle-tasks workflow and skill
Sections: 6 | Fixes: 3
Efficacy: 50%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/22-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The live-unmerged check runs after an operation that already fails on unmerged files

- Evidence: `[plans/pipeline-audit-20260905-114658/22-task.md:88-146, scripts/tackle-tasks/shared/commitTaskWork.ts:92-117]`
- The plan claims: an unowned unresolved path survives `commitTaskWork`, then the post-commit `git diff --diff-filter=U` check catches it with the planned error.
- Actually true: `commitTaskWork` stages owned changes and immediately runs `git commit` before returning. Git refuses to commit while any unmerged index entry remains, including an unowned one, so the planned post-commit check is unreachable in the scenario used by the new test. The test will receive the raw commit failure rather than the asserted `/unmerged path/` error.

### 2. The check examines the wrong checkout and cannot establish that markers were removed

- Evidence: `[scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts:17-27, scripts/tackle-tasks/fixConflicts/_packet.ts:12-15, plans/pipeline-audit-20260905-114658/22-task.md:136-143]`
- The plan claims: running `git -C packet.worktree diff --name-only --diff-filter=U` verifies the live conflict state.
- Actually true: conflicts are discovered in the supplied conflict checkout, and the packet preserves that checkout as `stoppedCheckoutPath`; it can be a nested occurrence rather than the root worktree. The proposed command always inspects `packet.worktree`. In addition, `--diff-filter=U` verifies index stages, not the prompt's stronger promise that conflict-marker lines are gone. An added file containing markers can be index-clean.

### 3. The receipt is shape-checked but not semantically enforced

- Evidence: `[scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts:60-84, plans/pipeline-audit-20260905-114658/22-task.md:116-143]`
- The plan claims: the consumer validates `additionalData.resolved` and `unresolvedPaths` before continuing the rebase.
- Actually true: the proposed code accepts `resolved: false`, accepts a non-empty `unresolvedPaths`, and accepts arbitrary non-string array elements. It then commits and returns `CONTINUE` whenever the later root-worktree index check is empty. That contradicts the prompt, which explicitly permits `resolved: false` as a legitimate outcome that must not be treated as a successful resolution.

## Durable fixes

### Fix for issue 1

- Change: Move conflict verification before the commit attempt, or split the shared stage/commit operation so the consumer can stage the intended conflict paths, verify the resulting index, and only then commit. Add a test proving an unresolved unowned path produces the consumer's deterministic error before `git commit` runs.
- Durable because: Every continuation is gated on verified conflict state rather than on whether a lower-level commit happens to fail first.

### Fix for issue 2

- Change: Verify `stoppedCheckoutPath` and the exact `conflictedFilePaths`, including nested occurrences. Add live checks for both unmerged index entries and unresolved marker content (with an explicit strategy for binary/delete conflicts) before continuation, plus a nested-submodule conflict test and a staged-marker test.
- Durable because: The verification follows the checkout where the rebase actually stopped and covers the prompt's marker-removal contract instead of only root index state.

### Fix for issue 3

- Change: Define and enforce the full receipt contract: `resolved` must be `true` to take the continuation path, `unresolvedPaths` must be an array of strings and empty when resolved, and a false or contradictory receipt must route back through the bounded conflict-fix/failure decision without committing. Add an end-to-end test that takes the emitted prompt-shaped answer through `writeAgentAnswer` and this consumer.
- Durable because: Both syntax and meaning are checked at the trust boundary, and the integration test covers the protocol mismatch that caused the original failure.

## Sections that hold up

- Step 1's packet-envelope conversion — verified against `scripts/tackle-tasks/shared/whatToReturn.ts:6-20` and `scripts/tackle-tasks/shared/FixConflictsBodyEmitter.ts:81-84`
- Existing packet fields needed for verification — verified against `scripts/tackle-tasks/commitMergeConflictFixIfNeeded/_packet.ts:2-19`
- Verification command structure — verified against `package.json:2-8`
