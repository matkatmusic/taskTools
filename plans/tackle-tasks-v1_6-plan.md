# tackle-tasks v1.6: build the 18-block monolith design

Companion fact sheet: `plans/tackle-tasks-v1_6-blocks.md` (per block: absorbed v1.5 boxes, helpers to call, decisions, counters, exit types).
Reading example, already written: `scripts/steps/pipeline-monolith/` (moves to its group folder in group 0).
The v1.5 code is under `archive/tackle-tasks-v1_5/`. Read it; do not import from it.

## Fixed decisions

1. Diagrams live in `diagrams/tackle-tasks/<diagram>.mmd` at the repo root. Seven files, one per agent() entry. `_pipeline-monolith.mmd` is the unrolled overview, not a generator input.
2. Block scripts live in `scripts/tackle-tasks/<diagram>/<BLOCK>.ts`, with `<BLOCK>.template.json` and `<BLOCK>.test.ts` beside them.
3. One script per block name. A block that appears in several diagrams is owned by the lowest-numbered diagram that contains it. The other diagrams' `steps.json` entries point at that same script path.
4. Shared helper modules live in `scripts/tackle-tasks/shared/`, restored from the archive with `git mv`, plus their tests.
5. An orange (`returns_a_prompt`) block ends an agent() call. The hook walks into it, returns its prompt, and stops. The next agent() starts at the orange block's successor with `{...promptBlockInputPacket, ...agentAnswer}` as input.
6. A block with exactly one successor never emits `next`. A decision block always emits `next`, naming one of its `next[]` entries.
7. Every counter lives in `tasks.json` `run.history[latest].attempts` via `getAttemptCount` / `raiseAttemptCount` (`MAX_ATTEMPTS = 2`). Counter names: `clarify`, `planReview`, `testFixes`, `pipeline-rebase-conflict-fix`, `suiteFix`, `merge`. No counter rides the packet.
8. Exits take one 9-key packet: `box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch, exitType, exitNote`. Every sender narrows to it. `branch` is the task branch (`task-N`); the name `sourceBranch` is retired.
9. The base branch is never carried. A block that needs it runs `git -C <projectRoot> rev-parse --abbrev-ref HEAD`.
10. Tests: strict red-green per `~/.claude/guides/tdd.md`. Test names `test_<behavior>`. One behavior per test. Copying an archived test that covers the same behavior is allowed; adjust imports and paths.
11. Comments: one line, 20 words max. Coding style per `~/.claude/guides/coding-standards.md` (4-space indent, imperative, one condition per `if`).
12. Vocabulary: block input, block output, packet, exit path of a decision block, marked active / inactive. Never "claim", "seam", "arm", "door", "hand-off".

## Diagram ownership table

| # | Diagram file (`diagrams/tackle-tasks/`) | Folder (`scripts/tackle-tasks/`) | Blocks it OWNS (script lives here) | Blocks it references (owned elsewhere) |
|---|---|---|---|---|
| 1 | `pipeline-preambleStatusCheck.mmd` | `preambleStatusCheck/` | PREAMBLE_STATUS_CHECK, DOCUMENT_GENERATION, PLAN_THE_TASK, REPORT_ONLY_EXIT, FAILURES_EXIT, STOP | – |
| 2 | `pipeline-whatDidThePlannerReturn.mmd` | `whatDidThePlannerReturn/` | WHAT_DID_THE_PLANNER_RETURN, CODEX_REVIEWS_PLAN | DOCUMENT_GENERATION, PLAN_THE_TASK, FAILURES_EXIT, STOP |
| 3 | `pipeline-whatIsReviewVerdict.mmd` | `whatIsReviewVerdict/` | WHAT_IS_REVIEW_VERDICT, IMPLEMENT_TASK | PLAN_THE_TASK, FAILURES_EXIT, STOP |
| 4 | `pipeline-commitImplementationIfNeeded.mmd` | `commitImplementationIfNeeded/` | COMMIT_IMPLEMENTATION_IF_NEEDED, CODEX_REVIEWS_TESTS, LOCK_SOURCE_REPO, REBASE_ONTO_TARGET_BRANCH, FIX_CONFLICTS, RUN_FULL_SUITE, FIX_THE_CODEBASE_FOR_SUITE | IMPLEMENT_TASK, FAILURES_EXIT, STOP |
| 5 | `pipeline-areTestsFlagged.mmd` | `areTestsFlagged/` | ARE_TESTS_FLAGGED | IMPLEMENT_TASK, LOCK_SOURCE_REPO, REBASE_ONTO_TARGET_BRANCH, FIX_CONFLICTS, RUN_FULL_SUITE, FIX_THE_CODEBASE_FOR_SUITE, FAILURES_EXIT, STOP |
| 6 | `pipeline-commitMergeConflictFixIfNeeded.mmd` | `commitMergeConflictFixIfNeeded/` | COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED | FIX_CONFLICTS, RUN_FULL_SUITE, FIX_THE_CODEBASE_FOR_SUITE, REBASE_ONTO_TARGET_BRANCH, FAILURES_EXIT, STOP |
| 7 | `pipeline-runFullSuite.mmd` | `runFullSuite/` | – | RUN_FULL_SUITE, FIX_THE_CODEBASE_FOR_SUITE, REBASE_ONTO_TARGET_BRANCH, FIX_CONFLICTS, FAILURES_EXIT, STOP |

Group 4 owns 7 blocks; group 7 owns none. Rebalance: group 4 keeps its two entry-side blocks; the rebase and suite blocks move to the groups whose diagram is *about* them. The build groups below use this rebalanced ownership. The generator still writes each script under the lowest-numbered diagram folder; group 0 step 7 makes the generator honour an explicit owner map instead (see there).

## Build groups (file ownership, no overlap)

| Group | Folder | Blocks | Orange |
|---|---|---|---|
| 1 | `preambleStatusCheck/` | PREAMBLE_STATUS_CHECK, DOCUMENT_GENERATION, PLAN_THE_TASK | PLAN_THE_TASK |
| 2 | `whatDidThePlannerReturn/` | WHAT_DID_THE_PLANNER_RETURN, CODEX_REVIEWS_PLAN | CODEX_REVIEWS_PLAN |
| 3 | `whatIsReviewVerdict/` | WHAT_IS_REVIEW_VERDICT, IMPLEMENT_TASK | IMPLEMENT_TASK |
| 4 | `commitImplementationIfNeeded/` | COMMIT_IMPLEMENTATION_IF_NEEDED, CODEX_REVIEWS_TESTS | CODEX_REVIEWS_TESTS |
| 5 | `areTestsFlagged/` | ARE_TESTS_FLAGGED, LOCK_SOURCE_REPO, REBASE_ONTO_TARGET_BRANCH, FIX_CONFLICTS | FIX_CONFLICTS |
| 6 | `commitMergeConflictFixIfNeeded/` | COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED | – |
| 7 | `runFullSuite/` | RUN_FULL_SUITE, FIX_THE_CODEBASE_FOR_SUITE | FIX_THE_CODEBASE_FOR_SUITE |
| 8 | `exits/` | FAILURES_EXIT, REPORT_ONLY_EXIT, STOP | – |

Owner map (block → folder) for the generator: the table above. `exits/` is not a diagram; it is the owner folder of the three exit blocks.

## Entry points (computed by the generator, listed here to check against)

START = `PREAMBLE_STATUS_CHECK`. Other start blocks = each orange block's successor:
`WHAT_DID_THE_PLANNER_RETURN`, `WHAT_IS_REVIEW_VERDICT`, `COMMIT_IMPLEMENTATION_IF_NEEDED`, `ARE_TESTS_FLAGGED`, `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED`, `RUN_FULL_SUITE`. Seven in total.

## Packet shapes

One shape per entry, every green block in that entry emits exactly it (plus `next` when it decides). The orange block's input is that shape; the next entry's input is that shape plus the agent answer fields.

| Entry | Packet keys (all strings unless noted) |
|---|---|
| 1 | `box, scriptSignal, taskNumber:number, runId, projectRoot, worktree, branch, docsMode, planFile, exitType, exitNote` (already in `scripts/steps/pipeline-monolith/_packet.ts`) |
| 2 | entry 1 packet + agent answer `outcome: "PLAN"\|"CLARIFY", planFile, clarifyRequest` |
| 3 | `box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch, planFile, reviewOutputFile, exitType, exitNote` + agent answer from CODEX_REVIEWS_PLAN: `reviewOutputFile` |
| 4 | `box, scriptSignal, taskNumber, runId, projectRoot, worktree, branch, exitType, exitNote` + agent answer from IMPLEMENT_TASK: `message, additionalData` |
| 5 | entry 4 packet + agent answer from CODEX_REVIEWS_TESTS: `flagged:boolean, notes` |
| 6 | entry 4 packet + agent answer from FIX_CONFLICTS: `message, additionalData` |
| 7 | entry 4 packet + agent answer from FIX_THE_CODEBASE_FOR_SUITE: `message, additionalData` |
| exits | the 9-key shape (decision 8) |

Group 0 writes these as `_packet.ts` in each folder before the groups start, so every group codes against the same file.

## Group 0 — one agent, in this order, on this branch (no worktree)

1. `git mv plans/diagram/pipeline-*.mmd plans/diagram/_pipeline-monolith.mmd plans/diagram/index.html diagrams/tackle-tasks/`. Keep `plans/diagram/runs/` where it is (the hook writes there). Update `package.json` `steps` and `steps:watch` to `diagrams/tackle-tasks`. `index.html` needs no link change; verify it still lists the 7 files + monolith.
2. `git mv scripts/steps/pipeline-monolith/* scripts/tackle-tasks/preambleStatusCheck/`. Delete `scripts/steps/` and `scripts/steps.monolith.json`. The `_createFreshTaskWorktree.ts` there goes to `shared/`.
3. Restore helpers: `git mv archive/tackle-tasks-v1_5/scripts/tackle-tasks/<name>.ts scripts/tackle-tasks/shared/` for every name in the "Real helper functions" lines of `plans/tackle-tasks-v1_6-blocks.md`, and every module those import transitively from the archived folder. Restore each one's test from `archive/tackle-tasks-v1_5/tests/` to `scripts/tackle-tasks/shared/<name>.test.ts`, fixing import paths. Also restore `SkillBodyEmitter.ts` + test (the skill body) and `greenBoxPolicy.ts` + test. Do NOT restore: `pipelines.ts`, `generateTaskWorkflow.ts`, `emitPipelineOutput.ts`, `monolith-pipeline.ts`, `*Emitter.ts` files no block imports, `writeClarifyRequest.ts` (its body lives in the block), `generateTaskDocs.ts`, `updateTaskDocs.ts`, `lockSourceRepo.ts`, `resetTaskWorktree.ts`, `isTaskActive.ts`.
4. `scripts/generateSteps.ts`: `stepsRoot = scripts/tackle-tasks`; the diagram folder name maps to its folder (`pipeline-preambleStatusCheck.mmd` → `preambleStatusCheck/`); one script per block name via an owner map `BLOCK_OWNER_FOLDER: Record<string, string>` (the build-groups table, exits → `exits/`); `steps.json` keeps one entry per diagram per box, but `script`/`template` paths point at the owner folder. Update `tests/generateSteps.test.ts` for these rules (delete tests that assert the per-diagram folder rule).
5. `scripts/runStepHook.ts`: delete lines 304–307 (the "prompt block gets a fresh agent, stop before it" rule). `next` resolution stays by box name; look the next box up first in the same diagram, then in any diagram (one script, so either is the same script). Update `tests/runStepHook.test.ts`: the walk now ends AT a prompt block with `scriptSignal: "prompt"`.
6. `scripts/generateWorkflow.ts:47`: start blocks = `START_STEP` + every prompt block's successors. Remove prompt blocks themselves from the set. `START_STEP = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK"`. Update `tests/generateWorkflow.test.ts`.
7. `package.json` `test`: `node --test "tests/**/*.test.ts" "scripts/tackle-tasks/**/*.test.ts"`. `scripts/relatedTests.ts`: also look for `<same dir>/<name>.test.ts`.
8. Write `_packet.ts` in each of the 8 folders per the packet table. Write `exits/_packet.ts` as the 9-key shape.
9. `npm run steps`. Stubs appear for every block the diagrams name, under the owner folders. Commit nothing. Run `npx tsc --noEmit`; fix only group-0 files. Report the stub list.

## Groups 1–8 — one worktree each, two agents each

Implementer: edits only its folder. Does not run tests. Reports "done" and nothing else.
Tester: runs `node --test scripts/tackle-tasks/<folder>/*.test.ts` and `node --test --test-name-pattern="<BLOCK>" tests/stepTemplates.test.ts` for each owned block; fixes code, never weakens a test; reports the final pass/fail lines.

Every block, in this order (red-green):
1. Write `<BLOCK>.test.ts` from the block's rows in `plans/tackle-tasks-v1_6-blocks.md`: one `test_<behavior>` per decision branch, per exit type, per counter bump. Copy the archived test for each absorbed v1.5 box when it covers the same behavior (`archive/tackle-tasks-v1_5/tests/steps/<old diagram>/<OLD_BOX>.test.ts`).
2. Write `<BLOCK>.ts`: port the bodies of the absorbed v1.5 boxes (`archive/tackle-tasks-v1_5/scripts/steps/<old diagram>/<OLD_BOX>.ts`), calling helpers from `../shared/`. Input/output = the entry's `_packet.ts`. Same file shape as `scripts/tackle-tasks/preambleStatusCheck/PREAMBLE_STATUS_CHECK.ts` (the `main(input)` export + the `realpathSync` guard).
3. Write `<BLOCK>.template.json`: `input` = the entry packet with real-looking values; `output` = what `main` prints for the happy path; `agentAnswer` for orange blocks only. Fixture repos: copy the pattern in `archive/tackle-tasks-v1_5/scripts/steps/pipeline-suite/fixtures/setup.sh`.
4. Run the tests (tester).

Per-group notes:

- **Group 1** — `PREAMBLE_STATUS_CHECK`, `DOCUMENT_GENERATION`, `PLAN_THE_TASK` already exist. Fix imports to `../shared/`. Add the tests and templates. `DOCUMENT_GENERATION` returns no `briefFile`.
- **Group 2** — `WHAT_DID_THE_PLANNER_RETURN` already exists. `CODEX_REVIEWS_PLAN`: port `archive/.../pipeline-reviewPlan/CODEX_REVIEWS_PLAN.ts`; it calls `shared/CodexReviewBodyEmitter.ts:reviewQuestion`. Its agent answer is `reviewOutputFile`.
- **Group 3** — `WHAT_IS_REVIEW_VERDICT` absorbs VERDICT_* / UPDATE_TASK_ENTRY / ARE_2_REVIEWS_DONE. Counter: replace payload `reviewCount` with `attempts.planReview` (decision 7). `IMPLEMENT_TASK`: port `pipeline-implement/IMPLEMENT_TASK.ts` unchanged except the input shape.
- **Group 4** — `COMMIT_IMPLEMENTATION_IF_NEEDED` absorbs commit + all of pipeline-taskTests. `hasTests:false` → `next: LOCK_SOURCE_REPO`. `CODEX_REVIEWS_TESTS`: port `pipeline-reviewTests/CODEX_REVIEWS_TESTS.ts`; base branch per decision 9.
- **Group 5** — `ARE_TESTS_FLAGGED`: keep the v1.5 rule (`task.codexReviewNotes` non-empty means the second flag exits `tests-flagged`). `LOCK_SOURCE_REPO`: the 15-minute wait is a loop inside this one block (sleep with `Atomics.wait`, re-try `acquireSourceRepoLock`, wall clock from a `lockWaitStartedAt` local). `REBASE_ONTO_TARGET_BRANCH`: rebase + conflict check + counter `pipeline-rebase-conflict-fix`. `FIX_CONFLICTS`: port, calls `shared/FixConflictsBodyEmitter.ts`.
- **Group 6** — `COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED`: commit, `advanceTaskRebase`, finished → `next: RUN_FULL_SUITE`; new conflicts → same counter as group 5, `next: FIX_CONFLICTS` or `FAILURES_EXIT` (`rebase-stuck`).
- **Group 7** — `RUN_FULL_SUITE` absorbs pipeline-suite + pipeline-merge + pipeline-mergeSucceededExit: commit suite fix, run suite, counter `suiteFix` (decision 7, replaces payload `suiteFixAttempts`), fence check, merge, publication state, `merge` counter, then on ALL LANDED: record hashes, write `completed`, record files, clean up, closure note, mark inactive, archive, print `scriptSignal: "stop"`. This is the point of no return; order matters, copy it from `plans/tackle-tasks-v1_6-blocks.md` RUN_FULL_SUITE "live comments". `FIX_THE_CODEBASE_FOR_SUITE`: port.
- **Group 8** — `FAILURES_EXIT`: port the 13-box failures exit into one function (read publication state, write outcome or exit note, record modified files, mark inactive, release lease if held, release lock if held, print). `REPORT_ONLY_EXIT`: print only. `STOP`: prints `scriptSignal: "stop"`. All take the 9-key packet.

## Integration — one agent, after all 8 worktrees are merged into this branch

1. `npm run steps` (regenerates `steps.json` and `skills/tackle-tasks/tackle-tasks.workflow.js`).
2. `npx tsc --noEmit` clean.
3. Full suite loop: `npm test 2>&1 | rg -e '^✖' || echo "all passing"`, then `npm test 2>&1 | tail -50`; fix code, not tests, unless a test asserts v1.5 shape.
4. `tests/stepTemplates.test.ts` edge tests must pass for every edge in the 7 diagrams.
5. Reinstate the UserPromptSubmit `runStepHook` entry where it was removed (task #16).

## Test runs

1. Test repo `/Users/matkatmusicllc/Programming/taskTools-tackleTasks-Tests`: `git reset --hard e6078ec` on master; put tasks 1 and 2 back into `.taskTools/tasks.json` from `completedTasks.json` with `run`, `clarifyRequest`, `closureNote`, `commitHashes`, `completionDate` removed; remove leftover worktrees, `task-N` branches, and the source lock.
2. Run `/tackle-tasks 1`, then `/tackle-tasks 2`. Watch `plans/diagram/runs/run-log.md` in the test repo. Expect 7 or fewer agent() calls per clean run.
3. Verify the tree, not the log: `git log --oneline -3`, `git show --stat`, `tasks.json` empty, `completedTasks.json` has both, no worktrees left.
