# Handoff: tackle-tasks v1.6 integration (2026-08-26)

Repo: /Users/matkatmusicllc/Programming/taskTools-86, branch new-run-step-tool-integration, HEAD a7d3919 (user commit). Everything below is UNCOMMITTED in this tree. The user commits, never the agent. Never run `npm test` until the user says so.

## Done
- 19 diagram folders under scripts/tackle-tasks/ built (one implementer + one tester each, in worktrees ../taskTools-86-groups/<folder>, branches v1.6-<folder>), then copied into this tree. The worktrees are stale now; this tree is the truth.
- Rule change (user decision): extra packet keys are fine. scripts/templateShape.ts no longer reports "key is not in the template". Only "is missing" / wrong kind count.
- 10 real cross-diagram gaps fixed. `branch` = the task's own branch name (task-N), carried through; the base branch is always derived with `git -C <projectRoot> rev-parse --abbrev-ref HEAD`.
- scripts/steps.json: 17 blocks marked mutating:true; WHAT_DID_THE_PLANNER_RETURN unmarked (pure routing).
- shared/decideTestReview.ts (+test) ported from the archive.
- tests/stepTemplates.test.ts next-literal regex now allows hyphens.
- `npm run steps` runs clean and writes skills/tackle-tasks/tackle-tasks.workflow.js (untracked).
- Counts at last check: tests/stepTemplates.test.ts 257/257; scripts/tackle-tasks/**/*.test.ts 527/527; tsc: only the 6 known scripts/closeTasks.ts errors.

## Done just before the handoff (fix agent finished; 527/527 block tests, 255/255 edge tests, tsc clean except closeTasks.ts)
1. tsconfig.json `"exclude": ["scripts/tackle-tasks/**/fixtures/**"]` (a generated fixture file broke tsc).
2. Rename local identifiers/comments containing "claim" (banned word) in preambleStatusCheck/MARK_TASK_ACTIVE.ts, runFullSuite/*.test.ts, rebase/ARE_2_CONFLICT_FIXES_DONE_Q.test.ts, mergeSucceededExit/*.test.ts, commitMergeConflictFixIfNeeded/*.test.ts. The shared `claimTask` helper name stays.
3. failuresExit/RELEASE_WORKTREE_LEASE.ts: `catch { return false }` swallows every error; only the not-found case may return false. Its template `worktree` should point at fixtures/worktree, not projectRoot.
4. preambleStatusCheck/RESET_WORKTREE.ts: re-verify the lease is held by packet.runId before deleting the worktree/branch (use the existing shared/taskRunState.ts check).
5. steps.json: mutating:true for WRITE_CLARIFY_REQUEST and RECORD_MODIFIED_FILES_SUCCESS (both write tasks.json).
6. fixtures/.gitignore per folder with setup.sh so generated output (.git/, worktree/, generated json) is ignored; rerun each setup.sh to reset drift. preambleStatusCheck/fixtures/.taskTools/tasks.json is static and left active:true by tests.
7. Shorten 11 over-20-word comments (list in the review below).

## Reviewed but NOT yet fixed (9-folder rubric review)
- fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.template.json: ownedFilePaths relative, testFilePaths has "" → malformed `/read-file` line in the prompt.
- areTestsFlagged: ARE_TESTS_FLAGGED.ts:14, AMEND_ENTRY_WITH_CODEX_NOTES.ts:27, ARE_2_TEST_REVIEWS_DONE_Q.ts:21 set box/scriptSignal BEFORE `...core` spread; reorder so envelope keys come after.
- fixtures/.gitignore missing in commitImplementationIfNeeded, codexReviewsTests, fixTheCodebaseForSuite.
- planTheTask and codexReviewsPlan input templates list `planFile` the scripts never read (drop).
- shared/FixConflictsBodyEmitter.ts: line ~45 tells the agent to run `/ponytail:ponytail ultra` (delete); lines ~76-84 "COMMIT YOUR WORK" tell the agent to run commitTaskWork.ts from Bash — v1.5 side channel; v1.6 commits in COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED, so delete that section (its shared test becomes obsolete: update it).
- shared/CodexTestReviewBodyEmitter.ts:148 "Invoke the following skill verbatim" → reword like the other emitters. Line ~168 pipes the review into shared/decideTestReview.ts with the literal box name ARE_TESTS_FLAGGED; the agent returns {flagged, notes} in additionalData — decision pending: keep (agent runs decideTestReview) or move the decision into ARE_TESTS_FLAGGED.ts reading a reviewFile like CODEX_REVIEWS_PLAN does.
- Prompt "WHAT TO RETURN" text vs template agentAnswer: shared/planPrompt.ts:171 asks for top-level outcome/planFile/clarifyRequest but the template wraps them in additionalData; FixConflictsBodyEmitter.ts:105 asks for resolved/unresolvedPaths with template additionalData {}; FIX_THE_CODEBASE_FOR_SUITE.ts:79 asks for fixSummary with additionalData {}. Make prompt and template agree (put the fields inside additionalData in both).
- implementTask/IMPLEMENT_TASK.ts:12 `ponytail:` defaults maxFixRounds to 3 because no sender sets it — check whether maxFixRounds is still used at all.
- Dismissed: "FIX_CONFLICTS carries dead keys" (an orange block hands its whole input on; CONTINUE_REBASE needs stoppedOccurrenceId/stoppedCheckoutPath); "nested fixtures/.git blocks git add" (false; checked).

## Remaining tasks (from the original list)
- Full suite green (`npm test 2>&1 | rg -e '^✖' || echo "all passing"`, then tail -50; fix code not tests) — only when the user says so. Known: SkillBodyEmitter/greenBoxPolicy tests need the workflow file (now written); skills/tackle-tasks/SKILL.md and scripts/closeTasks.ts still use old paths.
- Reinstate the UserPromptSubmit runStepHook entry in .claude/settings.json (hooks/hooks.json line 16 still lists it).
- Reset the test repo /Users/matkatmusicllc/Programming/taskTools-tackleTasks-Tests (master → e6078ec; tasks 1 and 2 back into .taskTools/tasks.json stripped of run/clarifyRequest/closureNote/commitHashes/completionDate; worktrees, task-N branches, source lock cleared).
- v1.6 test runs: /tackle-tasks 1 then 2; verify the tree, not the log.
- Clean up: `git worktree remove` the 19 ../taskTools-86-groups/* worktrees and delete the v1.6-* branches once the user has committed this tree.

## Working rules the user set
ELI5 register, short sentences. Subagents do the work; the lead reviews. Fan-out agents never run tests; testers run only their folder + `node --test --test-name-pattern="<BLOCK>" tests/stepTemplates.test.ts`. Never commit/merge/`git add`/`git stash`. Words: block input, block output, packet, exit path; never claim/seam/arm/door/hand-off. One-line comments, 20 words max. Do not fix unused imports/vars. A contradiction → AskUserQuestion with options, recommended first. The Agent tool's auto-mode classifier randomly blocks some spawns; re-send with a shorter prompt.
