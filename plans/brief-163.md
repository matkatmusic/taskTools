# Task 163: tackle-tasks: orchestrator drives the merge scheduling queue and deletes the superseded workflow files

## User request

Create one task, blocked by task 153, closing the task-86 chain. Files must be exactly: ["plans/task-86-spec.md", "scripts/tackleTasksBrief.ts", "tests/tackleTasksBrief.test.ts", "tests/runMergePhase.test.ts", "skills/tackle-tasks/merge.workflow.js", "skills/tackle-tasks/plan.workflow.js", "skills/tackle-tasks/implement.workflow.js", "skills/tackle-tasks/test.workflow.js", "skills/tackle-tasks/verify.workflow.js"]. Difficulty around 6. Tests must NOT be "skip".

Title should be about: tackle-tasks: orchestrator drives the merge scheduling queue and deletes the superseded workflow files.

Description content to write:

The main orchestrator conversation is the only actor that can launch a workflow, receive its completion notification, and ask the approval gate — AskUserQuestion is not a workflow-script hook and is stripped from every subagent. Nothing in tasks 145-153 owns scripts/tackleTasksBrief.ts, which is where the orchestrator's instructions live, so the chain currently builds a merge scheduling queue that nothing drives. This task closes that gap.

Four things:

1. LAUNCH THE TAIL STAGES. Today the generated instructions stop after saying an approved task "enters the merge queue". They never launch anything. Rewrite them so that as each task is approved at its own gate, the orchestrator hands it to the merge scheduling queue (task 147) and launches skills/tackle-tasks/task.workflow.js with stage `rebase-test` (tasks 145-146) and then stage `merge` (tasks 150-152) for whichever task the queue says is next. Merging stays serial — one task at a time — because every merge moves the tip the next task rebases onto.

2. FEED OUTSTANDING-WORKFLOW STATE TO THE QUEUE. Task 148's early exit only fires on a zero-merge lap when no task workflow is still outstanding — still running, or finished but not yet approved. Only the orchestrator knows that. Define the explicit boundary through which that state reaches the queue, and pass it. Without it, a zero-merge lap mid-run ends the queue and abandons tasks that were never given a lap.

3. DROP THE close-tasks SKILL STEP. The instructions still tell the orchestrator to run the close-tasks skill at the end. Task 152 replaces that with a direct, hash-gated scripts/closeTasks.ts call inside the merge stage. Leaving both in means a task can be archived twice, or archived by the skill without the merge-hash gate that task 152 exists to enforce.

4. DELETE THE SUPERSEDED WORKFLOW FILES. plans/task-86-spec.md is explicit that this happens here, not in the task that supersedes each one: "Deleting it, and the other superseded `*.workflow.js` files, happens at the end of the chain, not in the task that supersedes each one." Task 145 folds merge.workflow.js's conflict-fixing prompt into the rebase-test stage but deliberately does not delete it. THE SUPERSEDED FILES ARE EXACTLY FIVE, and all five are in this task's files: merge.workflow.js, plan.workflow.js, implement.workflow.js, test.workflow.js and verify.workflow.js. task.workflow.js holds all four stages, so the per-stage files it replaced go; test.workflow.js is named by the spec as disappearing as a separate phase. blockers.workflow.js is assumed unchanged and stays, as does task.workflow.js. NO production file in the repository references any of the five today — scripts/tackleTasksBrief.ts constructs only blockers.workflow.js and task.workflow.js. Re-run that check before removing each one; while it holds, each removal is a pure deletion with no referrer to update.

Note on scripts/prepareTasks.ts: task 147 comments out the aggregated stepOutputsFile plumbing inside scripts/runMergePhase.ts without touching resolveStepOutputsPath in scripts/prepareTasks.ts, so tests/tackleTasksBrief.test.ts still compiles; update it here only where the instruction text it asserts on has changed.

RETIRED CODE VS RETIRED FILES. Inside scripts/tackleTasksBrief.ts, instruction text and helpers this task supersedes — the close-tasks skill step, the old "enters the merge queue" ending — are COMMENTED OUT under a `// RETIRED (task 163): ...` header, not deleted. Removing a whole file is the one exception, and it applies only to the five superseded workflow files named above: those five are the only thing in the entire 144-153 and 163 chain that leaves the tree.

tests: assert the generated instructions launch the rebase-test and merge stages rather than stopping at "enters the merge queue"; assert they no longer mention the close-tasks skill; assert every superseded workflow file is gone and nothing imports it.

scripts/tackleTasksBrief.ts holds the orchestrator's generated instructions and is owned by no task in the 144-153 chain, so that chain builds a merge scheduling queue with nothing to start it. Only the main orchestrator conversation can launch a workflow, receive its completion notification, and ask the approval gate, because AskUserQuestion is not a workflow-script hook and is stripped from every subagent. The current instruction text stops after saying an approved task enters the merge queue, and still ends a run with the close-tasks skill, which task 152 replaces with a hash-gated direct call to scripts/closeTasks.ts. Task 148's zero-merge early exit must know whether any task workflow is still outstanding and only the orchestrator holds that state, so this task defines the explicit boundary carrying it into the queue. plans/task-86-spec.md assigns deletion of merge.workflow.js and the other superseded workflow files to the end of the chain rather than to the task that supersedes each one, which is why task 145 folds in merge.workflow.js's conflict-fixing prompt but deliberately leaves the file on disk. The superseded set is exactly five files, all of them in this task's files: skills/tackle-tasks/merge.workflow.js, plan.workflow.js, implement.workflow.js, test.workflow.js and verify.workflow.js — task.workflow.js holds all four stages that the per-stage files used to run, and the spec names test.workflow.js as disappearing as a separate phase. no production file in the repository references any of the five today — scripts/tackleTasksBrief.ts constructs only blockers.workflow.js and task.workflow.js — so each removal is a pure deletion with no referrer to update, and that check is re-run before each file is removed; blockers.workflow.js and task.workflow.js are unchanged and stay. tests/tackleTasksBrief.test.ts references the aggregated stepOutputsFile, which task 147 stops writing from scripts/runMergePhase.ts without removing resolveStepOutputsPath from scripts/prepareTasks.ts, so that helper and its callers still compile; update this test only where the instruction text it asserts on has changed. Being last in the chain, this is the first point at which the whole serial tail exists to be exercised end to end, so its tests cover BOTH groups: the generated-instruction and file-removal assertions, AND real worktrees driven through the queue. The end-to-end cases are additional to the instruction-text assertions, never a replacement for them. tests/runMergePhase.test.ts is included so those end-to-end cases have a home alongside the queue they exercise.

READ-ONLY FILES IN THIS FENCE. Four of the declared files are present so this task can READ them. Do not edit them, and do not let a plan propose editing them:
- scripts/mergeTaskWorktrees.ts — the ordered merge primitive, owned by task 144. Read it for the exact parameter and return contracts of mergeTaskDeepestFirst, rebaseParentOntoSourceAndTest, rebaseSubmoduleLayersDeepestFirst, uncommittedChangedFiles and removeWorktreeAndBranch, so the end-to-end assertions match real behavior instead of a guess.
- tests/taskWorkflowMergeStage.test.ts — read it for the established temp-git-repo and repositoryManifest fixture pattern, and reuse that pattern in tests/runMergePhase.test.ts. Do not add cases to it and do not move cases out of it.
- scripts/runMergePhase.ts — the queue's lap, retry and exit logic, owned by tasks 147, 148 and 149. Read it to drive the queue correctly. A plan that changes queue logic here is wrong.
- skills/tackle-tasks/task.workflow.js — read it for the stage names and argument shape the orchestrator must launch. Its rebase-test and merge stages are owned by tasks 145, 146 and 150 to 153.

The files this task actually WRITES are: scripts/tackleTasksBrief.ts, tests/tackleTasksBrief.test.ts, tests/runMergePhase.test.ts, plans/task-86-spec.md, and the five superseded workflow files, which it deletes.

## Files

@plans/task-86-spec.md
@scripts/tackleTasksBrief.ts
@tests/tackleTasksBrief.test.ts
@tests/runMergePhase.test.ts
@skills/tackle-tasks/merge.workflow.js
@skills/tackle-tasks/plan.workflow.js
@skills/tackle-tasks/implement.workflow.js
@skills/tackle-tasks/test.workflow.js
@skills/tackle-tasks/verify.workflow.js
@skills/tackle-tasks/task.workflow.js
@scripts/runMergePhase.ts
@scripts/mergeTaskWorktrees.ts
@tests/taskWorkflowMergeStage.test.ts