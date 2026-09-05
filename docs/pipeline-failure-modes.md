# tackle-tasks pipeline failure modes

Window: 2026-07-07 to 2026-09-05. Sources: 210 run logs and 1170 packets under `.taskTools/runs/`, the git history of `plans/checkpoint.json`, 2573 session transcripts searched by error text, and the audit under `plans/pipeline-audit-20260905-114658/`. Full evidence with commands and raw output: the audit files there plus `plans/audit-2026-09-05/`.

Stages: CREATE_WORKTREE covers launch, preamble, worktree, lease, and lock failures.

| # | Count | Stage | Symptom | Root cause | Fixed in HEAD | Guard |
|---|---|---|---|---|---|---|
| 1 | 88 firings in 39 runs | CREATE_WORKTREE | Every block ran twice per `/run-step`; clarify and attempt counters doubled; 8 hard failures in MARK_TASK_ACTIVE and MARK_TASK_INACTIVE | `.claude/settings.json` registered `runStepHook.ts` a second time on top of `hooks/hooks.json` | Yes, `72deb79` emptied the settings hooks | PREFLIGHT_OK_Q duplicate-hook check. `tests/hookInstalled.test.ts` uses `.some()` and would not catch a return |
| 2 | 8 in 5 sessions | CREATE_WORKTREE (launch) | Workflow tool rejects `scriptPath` under `skills/tackle-tasks/` | `SkillBodyEmitter.ts:9` resolves the workflow file relative to the plugin checkout, not the session working directory | No. Task 194 tracks the move under `<projectRoot>/.taskTools/workflows/` | None. `SkillBodyEmitter.test.ts:67` pins the broken path |
| 3 | 3 | CREATE_WORKTREE | `cannot change to '.../staging': No such file or directory`, `could not move refs/heads/staging` | `prepareTasks.ts` `resolveOrCreateStagingTip` fast-forwards a worktree path parsed from git stderr and never checks the directory exists or runs `git worktree prune` | Partial, `78b1fc1` covers the directory-exists case | `tests/prepareTasks.test.ts:161` happy path only |
| 4 | 3 | CLARIFY | Clarify answer never reaches the planner; a resumed run replays the pre-answer packet | (a) `clarifyTask.ts` left the worktree checkpoint in place. (b) `PLAN_THE_TASK.ts:28,62` call `planPrompt` without `extra`, so `clarifyRequest` is dead | (a) yes, `72deb79`. (b) no | (a) `tests/clarifyTask.test.ts`. (b) none |
| 5 | 2 | CREATE_WORKTREE (launch) | `HOOK EXCEPTION ... Unexpected end of JSON input` | `runStepHook.ts:268` and `resetTask.ts:69` parse agent-written packet JSON with no truncation check | No | None |
| 6 | 2 | REVIEW | `WHAT_IS_REVIEW_VERDICT exited 1: Unexpected end of JSON input` reading `plans/codex-review.json` | `readReviewJson.ts` strips a code fence but not a truncated body | No | `readReviewJson.test.ts:34` pins the throw only |
| 7 | 2 | CREATE_WORKTREE | `worktree ... is already owned by a live run (lease at ...)` | `prepareTasks.ts` `acquireTaskWorktreeLease` throws on any existing lease; `recoverStaleTaskWorktreeLease` is never called from the pipeline | Partial, manual recovery only | Recovery function tested at `tests/prepareTasks.test.ts:337`; in-flow recovery none |
| 8 | 2 | IMPLEMENT | `cannot rebase: You have unstaged changes` after a rename | `commitTaskWork.ts` read `git status` with renames on and sliced the wrong path; `git add -A` failed on a staged deletion | Yes for owned files, `a696d9d`. Path rewrites outside the fence remain open | `commitTaskWork.test.ts:130` for the fixed case |
| 9 | 2 | MERGE | `source checkout ... is dirty, refusing to merge` | Intended guard in `mergeTaskWorktree.ts:95` | Working as designed | `mergeTaskWorktree.test.ts` three cases |
| 10 | 1 | IMPLEMENT | `staging worktree ... is on "staging", expected "new-run-step-tool-integration"` | `COMMIT_IMPLEMENTATION_IF_NEEDED.ts` derived the base branch from the current checkout instead of `staging` | Yes, `c48f576` | Indirect only. The fixture always sits on `staging` |
| 11 | 1 | CREATE_WORKTREE | `writeTaskExitNotes: unknown exit type "not-resumable"` | `writeTaskExitNotes.ts` exit-type list lacked the value the resumable check emits | Yes, `194e9c8` | `writeTaskExitNotes.test.ts:46` |
| 12 | 1 | REVIEW | `review fix names section "...", which the plan does not have` | `WHAT_IS_REVIEW_VERDICT.ts:45` rejects a fix naming a section the same review renamed | Guard by design | None |
| 13 | 1 | CREATE_WORKTREE | `LOCK_SOURCE_REPO exited 1: EEXIST ... mkdir '.git'` | `sourceRepoLock.ts:72` mutation-guard `mkdirSync` race | Unknown | None for this message |
| 14 | 1 | TEST | `RUN_FULL_SUITE did not exit within 10000ms` | `runStepHook.ts` step timeout was 10 seconds | Yes, `d146b3b` raised it to 300 seconds | None |
| 15 | 0 seen | MERGE | Every resume into ARCHIVE_TASK fails with `closureNote is missing` | `resumeRun.ts` `findResumeEntry` rebuilds the ARCHIVE_TASK input without `closureNote` | No | `resumeRun.test.ts:166` asserts the broken payload |
| 16 | 0 seen | CREATE_WORKTREE | No disk-space check | Absent | Yes, PREFLIGHT_OK_Q | `PREFLIGHT_OK_Q.test.ts` |
| 17 | 0 seen | CREATE_WORKTREE | Plan-mode default blocks every write | Absent | Yes, PREFLIGHT_OK_Q | `PREFLIGHT_OK_Q.test.ts` |
| 18 | 0 seen | PLAN | Bad `--model` flag in `spawnAgentCli.ts` | Absent | Yes | `tests/spawnAgentCliModelNames.test.ts` |

Not in the list: "stop-hook stages renames but not path rewrites" is row 8's open half. PREFLIGHT_OK_Q also rejects a `scripts/steps.json` script path outside `scripts/`; that is a different check from row 2.
