# Review of Plan 1, Plan 2, Plan 3

Date: 2026-09-17. Each finding was checked against the source code. "Proven" means a command or a code line shows it.
Severity: BLOCKER = the work fails or does harm on the first try. HIGH = a wrong result that the plan's own checks do not catch. LOW = a wrong number or a wrong word.

Health of each plan: Plan 1 is sound, with one blind check. Plan 2 has two design holes. Plan 3 cannot work as written.

## A. Does each plan follow `~/.claude/guides/planning.md`?

| Rule in the guide | Plan 1 | Plan 2 | Plan 3 |
|---|---|---|---|
| Mostly "how", little "why" | Yes | Partly. The Context spends 20 lines on the cause. Keep it; it stops a wrong fix. | Yes |
| Says WHERE the work goes | Yes | Yes | Partly. Two needed files have no owner (C1, C4). |
| Little ambiguity | Yes | Yes | No. See C9. |
| Test first (tdd.md) | Conflict, see A1 | Conflict, see A1 | Conflict, see A1 |
| Snippets follow coding-standards.md | Yes | Yes | Partly. B1 snippet uses the names `own` and `WAIT`. Say what they are: `ownPacket`, `waitBuffer`. |

**A1 (all three plans, HIGH). The rules block contradicts itself.** Rule 1: "see it fail for the stated reason". Rule 2: "Edit agents never run tests". An edit agent cannot see RED. Plan 2 names no agents at all, so nobody is told to watch its five "Expected RED" lines.
Recommendation: add one sentence to the rules block of each plan. Either "the edit agent may run ONLY its own test file with `node --test <file>` to see RED and GREEN", or "the one test-run agent confirms each RED reason from the test names listed here". Pick one; write it in all three.

**A2 (all three plans, HIGH). Line numbers go stale inside the plan's own order of work.**
- Plan 2: Step 2 adds one line at `stagingWorktree.ts:12`. Step 4 then names `:31-40`, which is now `:32-41`.
- Plan 1: Phase 1 adds types and constants to `generateSteps.ts`. If they go above line 31, the P4 lines `:17`, `:21`, `:26-31` move.
- Plan 3 names `generateSteps.ts:132` and `:204-218`. Plan 1 runs first and moves them.
Recommendation: name the function or the constant next to each line number (for example "`NEXT_BLOCK_OVERRIDES`, today `:17`"). In Plan 1 say "add the new types and constants below the `preambleStatusCheck` list".

## B. Plan 1 — generator reads the new style

Checked and correct: every line citation; the parser reads `plans/preamble-current.mmd` today (40 boxes, no `class` line leaks in); the Cycle A algorithm gives the expected value for all 5 fixtures, the self-loop too; the label regex has no false match in both `.mmd` files; the 4 `block:` values equal today's `next` values; the 11 `mutating` ids; the 16 prefixes; nothing builds a file name from a box name; the three changed helpers each have one caller.

**B1 (HIGH, proven). The Phase 4 search cannot see a diagram file.** The pattern needs `"`, `'` or `:` before the name. A mermaid id has a space or `-->` before it. All 6 files that agent P1 owns give zero hits today, before any rename. The search prints nothing if P1 does the work right, and nothing if P1 does it wrong.
Recommendation: add a Phase 4 step: `rg -nw '<the 16 old names>' diagrams/tackle-tasks*/pipeline-preambleStatusCheck.mmd diagrams/tackle-tasks*/pipeline-commitMergeConflictFixIfNeeded.mmd diagrams/tackle-tasks*/pipeline-whatDidThePlannerReturn.mmd`. Expected: each hit is inside a `file:` text only.

**B2 (HIGH, proven). The literal rule misses three live places.**
- `tests/generateSteps.test.ts:365,369`: `note: "PREAMBLE_STATUS_CHECK.ts for PREAMBLE_STATUS_CHECK"`. The rule changes nothing here (first name has `.` after it, second has a space before it). Cycle D makes the real note `"PREAMBLE_STATUS_CHECK.ts for Q_PREAMBLE_STATUS_CHECK"`. The test fails. P5 detail does not list these lines.
- `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:63,66`: the old name is in a backtick error text. The plan lists only `:13` for this file.
- The plan says the rule "renames regex literals". It does not: `tests/workflowLivenessHook.test.ts:47` has `/PREAMBLE_STATUS_CHECK/`. This one still passes, because the new name contains the old name. The sentence in the plan is wrong all the same.
Recommendation: add the first two as hand edits in P5 and P2. Remove "regex literals" from the rule text.

**B3 (HIGH). The safety of two cross-diagram nodes depends on one line order, and no test holds that order.** After Phase 2, `Q_DOES_FENCE_COVER_WORKTREE_Q` and `B_DOCUMENT_GENERATION` are in old-style diagrams with no `file:` line. They are safe only because the dashed-box skip (today `:356`) runs BEFORE the new "no `file:` line: throw" rule. Cycle D gives that order. A later edit can swap it and the generator then throws on the real diagrams.
Recommendation: add one RED test to Cycle F: an old-style diagram draws `Q_X` with arrows in only; a new-style diagram owns `Q_X` with a `file:` line; `run()` does not throw and writes one entry.

**B4 (LOW, proven). The closing "fact to know" misses one saved file.** `shared/rebaseIntent.ts` writes `<worktree>.rebase-intent.json` with a full old block key (`resetTask.ts:422-423`). A file written before the rename names a block that no longer exists.
Recommendation: add to the closing fact: "and remove each `*.rebase-intent.json` beside a task worktree".

**B5 (LOW). `tackle-tasks.workflow.js` is kept by hand.** The write in `generateWorkflow.ts:10-11` is retired. The plan's hand edit of line 7 is right. Nothing to change; do not expect Phase 3 to write it.

## C. Plan 3 — the revised preamble flow

Checked and correct: nearly every line citation and all five test names; `buildLockOwner("", 1)` gives `":1"` with no throw; no lock code parses the owner; `addTaskFiles` has no "file must exist" rule, so both new callers work; `parseOccurrencePath` and `docsMode: "UPDATE"` are real; the `prepareTasks.ts` function bounds; the folded arrows of `plans/preamble-revised.mmd` match Wave B one to one; the folder name `task-N-catchUpMerge` is not read as a task worktree (the scan uses `/^task-\d+$/`); the template rules for a prompt block; the fast diagram is a byte copy and Wave C owns it.

**C1 (BLOCKER, proven). Nothing sends the flow into the new blocks.** `PREFLIGHT_OK_Q.ts:130` returns `next: "MARK_TASK_ACTIVE"`. No wave owns `PREFLIGHT_OK_Q.ts`, its test, or its template. After Wave C the diagram says the YES exit goes to `Q_LOCK_STAGING_FOR_CATCH_UP`, and the hook refuses a `next` that the diagram does not list (`runStepHook.ts:537`). Each launch fails at preflight.
Recommendation: add a Wave B owner "B0b": `PREFLIGHT_OK_Q.ts` (`next: "Q_LOCK_STAGING_FOR_CATCH_UP"`), its test, its template. Also `MARK_TASK_ACTIVE.template.json` `input.box` (wrong already today: `"IS_TASK_ACTIVE_Q"`).

**C2 (BLOCKER, proven). A throw in a catch-up block leaves the lock held, with no release.** `buildFailure` (`runStepHook.ts:282-285`) returns at once when `worktree` is `""`. It never reaches `FAILURES_EXIT`. B1 to B4 all run with `worktree: ""` and all call `refreshOwnedSourceRepoLockOrThrow`; B2 and B4 also run git commands that can fail. After a throw the `":N"` lock stays. After 15 minutes `acquireSourceRepoLock` answers `"recoverable"`, which needs a hand call of `recoverSourceRepoLock`. B1 treats that answer as "wait", with no deadline. Each other task then waits with no end. Only a new launch of the SAME task frees it (`already-held-by-me`).
Recommendation: the user picks the rule (see "Decisions" below). The plan must state it and test it: for example a Wave H test `test_runStepHook_releasesTheSourceLockWhenABlockThrowsBeforeAWorktreeExists`.

**C3 (BLOCKER for cost, proven). USER DECISION 2026-09-17: use the lock-wait loop the pipeline already has.** Wave H turns a free wait into about 240 agent turns for each 20 minutes: B1 waits 5 seconds and names itself, Wave H stops the walk on each self-next, and the workflow `while(true)` has no cap.
The pipeline already solved this in `diagrams/tackle-tasks/pipeline-lockSourceRepo.mmd` and `scripts/tackle-tasks/lockSourceRepo/`. Four blocks with four different names: `LOCK_SOURCE_REPO --> WAS_LOCK_ACQUIRED_Q -- NO --> HAS_LOCK_WAIT_DEADLINE_PASSED_Q -- NO --> WAIT_FOR_LOCK --> LOCK_SOURCE_REPO`. No block names itself, so the hook walks the full loop inside ONE hook call. Zero agent turns.
Correction to the plan: remove Wave H fully (no `runStepHook.ts` change, no self-next). Replace B1 with copies of those blocks in `preambleStatusCheck/`, drawn in the preamble diagram. They must be copies, not the same scripts: `LOCK_SOURCE_REPO.ts` and `WAIT_FOR_LOCK.ts` build their output field by field from `lockSourceRepo/_packet.ts`, so they drop the preamble fields `docsMode` and `planFile`; and that diagram's exit is fixed to `REBASE_ONTO_TARGET_BRANCH`. The copies use `{ ...packet }`.
Open point: the existing loop ends after `LOCK_WAIT_DEADLINE_MS` (5 minutes) and goes to `FAILURES_EXIT`. Plan 3 says "the lock wait has no deadline". A loop inside one hook call with no deadline is killed by the hook limit (`hooks/hooks.json:17`, 1200 seconds). The plan must pick one: copy the deadline block too (its YES exit goes to `REPORT_ONLY_EXIT`, a fifth stop reason), or draw no deadline block and accept the 1200-second kill.

**C4 (HIGH, proven). `tests/tackleTasksAcceptance.test.ts` walks the real preamble and has no owner.** 6 of its 8 tests drive the real config from the first block. After Plan 3 that walk meets the lock block and the catch-up block. D1's rule is "code changes, not test changes", and D1 can send a failure only to "the agent that owns the file". No agent owns this file.
Recommendation: add an owner for this file in Wave C. State that a test which checks a retired route is updated or commented out, not "fixed" in code.

**C5 (HIGH, proven). B8 step 9 can name a `next` that the hook refuses.** B8 copies the "retained intent" return: `next: intent.targetBlock`. `resetTask.ts:422` writes any block key there. `runStepHook.ts:537` refuses a `next` that is not in the block's drawn list. The drawn list of `Q_CONTINUE_RESUMED_REBASE` has two targets only. The test `..._honorsARetainedRebaseIntentWhenTheRebaseFinishes` calls `main()` directly, so it passes while the real hook fails.
Recommendation: the user picks (see "Decisions"). If the intent return stays, the RED test must run through the hook, not through `main()`.

**C6 (MEDIUM, from the code; not seen in a run).** `Q_CATCH_UP_STAGING` YES releases the lock. After that, `CREATE_WORKTREE`, `RESET_WORKTREE` and `ensureStagingWorktree` call the OLD `resolveOrCreateStagingTipEverywhere`, which still THROWS on a conflict, and no lock covers that call. The plan says they "find nothing to do". That is true only when the user's branch did not move in between.
Recommendation: no code change. Change the sentence in A1 to say what is true, so the first report of that throw is not a surprise.

**C7 (LOW, proven) Wrong words and numbers.**
- Fact 9: "No writer for `createsFiles` exists today" is false. `scripts/shared/appendTask.ts:61-62` writes it when a task is made. True text: "no code adds to `createsFiles` of a task that exists".
- Fact 7: `stepTemplates.test.ts:106` is a different, stricter test (it runs the real script). Only `:133` is the key-subset check.
- B5: "Comment out `:11-21`". The body starts at `:10`.
- B8 step 9: "`IS_REBASE_FINISHED_Q.ts:17-23`". The intent code is `:15-25`.
- Template bases: `IS_PREVIOUS_RUN_RESUMABLE_Q.template.json:3-13` has the POST shape. No file has the PRE shape today. The folder `fixtures/mutating-example` does not exist on disk (an old habit of each mutating template; harmless because the 8 new blocks are `mutating`).
- A1 copies `:229-281`. A comment "RETIRED (task 8, reversed 2026-09-08)" sits right above that live code. Tell the A1 agent the code is live.

**C8 (LOW). A3 says "copied word for word".** `FIX_CONFLICTS_SECTIONS`, `absolutePathsSection` and `whatToReturnSection` are exported. Say "import and call" for the functions, and "copy" only for the text that changes.

**C9 (HIGH, planning guide). Wave C asks the agent to merge two diagrams by thought.** "Start from the live Plan 1 diagram ... apply `plans/preamble-revised.mmd` with these corrections" (7 corrections). `plans/preamble-revised.mmd:83` still draws `Q_CHOICE_COMMIT_CATCH_UP_MERGE_Y --> B_MARK_TASK_ACTIVE`, and still has the old block name and the old folder words.
Recommendation: apply the 7 corrections and the `file:` and `block:` lines to `plans/preamble-revised.mmd` NOW, in the planning session. Wave C then becomes: copy the file to two places, run `npm run steps`.

## D. Plan 2 — the `awaitingTesting` folder

Checked and correct: every line citation, byte for byte; every helper name, parameter name and import; `makeCommittedRepo` makes `seed.txt`; the Step 9 fixture reaches its assert (no test gate in `runMergeCli`); `runMergeCli` is the ONLY caller of `ensureStagingWorktree` that does not pass `"staging"`; `git worktree remove --force` works, also with a filled submodule (git 2.55.0); the Step 3 fixture shows the real failure (`status` has lines, `diff --quiet` is 0, no untracked file).

**D0 (HIGH, user finding 2026-09-17). The Context does not say clearly what problem the plan solves.** It opens with word use, then an error text, then a cause story. The reader must build the problem from those parts.
Recommendation: make these the first lines of Context. "Problem: the pipeline keeps ONE shared checkout folder for the `staging` branch. Two things are wrong with it. (1) The folder is named `staging`, the same word as the branch, so people and code mix the two up. (2) The merge tool (`--merge`) can put that folder on the USER'S branch. When the user then commits on that branch, the folder looks dirty to the guard, and EVERY pipeline run throws (task 29). Goal: the folder is named `awaitingTesting`; it is always on the branch `staging`; a folder left in the broken state repairs itself when it holds no work."

**D1 (BLOCKER, proven). Step 10 breaks a promise that the skill makes to the user.** `scripts/merge-worktree-tasks/mergeWorktreeTasksBrief.ts:43-46` tells the agent to say: the work "is now on the branch you were on when you ran `--discover`". This brief is the only caller of `--merge`. After Step 10 the work is on `staging`. The plan does not name this file.
Recommendation: the user picks (see "Decisions"). If Step 10 stays, add `mergeWorktreeTasksBrief.ts` and its test to the Files list, with the new sentence.

**D2 (BLOCKER, proven with a scratch repo). The "holds work" rule calls staged work "no work" and removes it by force.**
| Folder state | `diff --quiet` | untracked | The plan's verdict |
|---|---|---|---|
| file edited, then `git add` | 0 | none | no work: REMOVED |
| `git merge --no-commit`, no conflict | 0 | none | no work: REMOVED |
| merge stopped on a conflict | 1 | none | holds work: refuses |
The real failure and staged work look the same to the rule. One fact tells them apart, and the plan's own Context states it: in the real failure the index is "exactly the tree of old commit `ff97b51`".
Recommendation: add a third check, written inline in both places: `git -C <folder> write-tree` must equal one line of `git -C <folder> log --format=%T HEAD`. Not equal: throw "holds work". The scratch repo proved this check separates the cases. Add two RED tests for each place: `..._refusesWhenAnEditIsStagedOnly`, `..._refusesWhenAMergeIsStoppedBeforeItsCommit`.

**D3 (HIGH, proven). No test covers the normal old folder.** Steps 5 and 6 put the retired folder on the USER'S branch. On each machine that ran the pipeline, the retired folder is on `staging`. This repo has one now: `.../taskTools-1f205b9e/staging [staging]`.
Recommendation: add `test_ensureStagingWorktree_removesARetiredStagingFolderLeftOnTheStagingBranch`, plus the two D2 tests on that fixture.

**D4 (MEDIUM, from the code; not seen in a run).** Step 7 sits at the top of `ensureStagingWorktree`. `loadSourceManifest` (`occurrences.ts:54`) calls that from nearly every pipeline block. So the new throw can fire in the middle of a run, and two runs can both try the removal (no lock there). After the first good removal the `existsSync` is false and the code does nothing.
Recommendation: no code change. Add one sentence to Step 7 so the agent and the user know where the throw can show up.

**D5 (LOW, proven). Two wrong numbers in Verification.**
- "7 new tests pass". The plan adds 6 (Step 1: 1, Step 3: 1, Step 5: 1, Step 6: 2, Step 9: 1). With the D2 and D3 tests the number changes again.
- Item 2: the `rg` command prints 3 lines, not 2. Line 53 (`..., "staging");`) matches too.

**D6 (LOW).** Step 9 hedge "If `makeGroup` does not make `staging`": it does (`createWorktreeForGroup` makes it). Remove the hedge. Step 7 text says `git` is imported; it is a local function in the file.

## Decisions the user must make before the work starts

1. Plan 2, D1: DECIDED 2026-09-17, keep Step 10. Merged work lands on `staging`. The plan adds `scripts/merge-worktree-tasks/mergeWorktreeTasksBrief.ts` (the sentence at `:43-46`) and its test to the Files list.
2. Plan 3, C2: DECIDED 2026-09-17, the hook releases the lock. In `runStepHook.ts` `buildFailure`, on a block failure with no worktree, the hook releases the source-repo lock that this packet owns (`buildLockOwner(packet.runId, packet.taskNumber)`). RED test: `test_runStepHook_releasesTheSourceLockWhenABlockThrowsBeforeAWorktreeExists`. This is the only `runStepHook.ts` change left in Plan 3.
3. Plan 3, C3: DECIDED 2026-09-17, copy the existing lock-wait loop WITH its deadline block. The deadline YES exit goes to `REPORT_ONLY_EXIT`. The plan's Context must then say "five things may stop a launch", and must remove the sentence "The lock wait has no deadline".
4. Plan 3, C5: DECIDED, B8 keeps the "retained intent" return, and its RED test runs through the hook.
5. Plan 3, C5 follow-up: DECIDED 2026-09-17, Plan 3 adds a hook rule (Wave H2). The hook reads the retained rebase intent BEFORE the block runs and accepts a `next` that equals its `targetBlock`, even when the diagram does not draw it.

## Status, 2026-09-17

All findings and all five decisions are applied to the three plan files and to `plans/preamble-revised.mmd`. One finding of this review was wrong and is corrected in Plan 1: B1's search must look for an old name used as a NODE ID, because each new-style label starts with the old name. Plan 1 Phase 4 step 2 holds the proven command.

## Second pass, 2026-09-17

Three read-only agents reviewed the corrected plans. Applied: Plan 1 insert place (after `BLOCKS_BY_OWNER_FOLDER`'s closing `};`), `subgraph` skip for the label reader, six-file proof note; Plan 2 Step 11 names the comment, not a line; Plan 3 H1 releases the lock only when `projectRoot` is not empty, B5 throws when the worktree lease cannot be taken (USER DECISION), B0b and B1a wording. Rejected: a claim that the brief sentence is at `mergeWorktreeTasksBrief.ts:44-45` (it is at `:45-46`); a proposal to check the intent's `runId` in H2 (a relaunch after a reset has a new `runId`, so that check would refuse every real intent). Removed (USER DECISION): the Plan 1 skip-order test, because it can never be RED.
