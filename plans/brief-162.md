# Task 162: addTaskFiles.ts must refresh run-arguments.json so the archive gate sees a widened fence

## User request

RETARGETED 2026-08-09, narrower than originally written. Read this whole field; the old scope is gone.

The original bug named skills/tackle-tasks/plan.workflow.js. That file is now dead code — nothing launches it. scripts/tackleTasksBrief.ts launches skills/tackle-tasks/task.workflow.js instead, and that workflow re-reads tasks.json fresh at the start of every stage, so the plan/verify/implement half of the original bug is already fixed and must NOT be re-fixed here.

What survives is smaller and still real. scripts/prepareTasks.ts snapshots each task's `files` array into .taskTools/run-arguments.json once per run. When a fence widens mid-run, scripts/addTaskFiles.ts appends the new paths to tasks.json, but nothing rewrites that snapshot. scripts/mergePipeline.ts then reads the stale snapshot at lines 85-87, where it uses task.files to verify the task's code actually landed before archiving it. A too-narrow list makes that archive gate check fewer files than the task really owns, so the gate is weaker than it advertises.

Observed live twice: on task 144, and again on task 153 on 2026-08-09, when the orchestrator widened a fence and had to re-run prepareTasks.ts by hand. That manual workaround should not be necessary.

Fix: after addTaskFiles.ts mutates tasks.json, it must also rewrite .taskTools/run-arguments.json so every task's `files` array there matches tasks.json. Reuse the existing resolveRunArgumentsPath helper in scripts/prepareTasks.ts rather than re-deriving the path. Update only the `files` arrays — do not re-snapshot the rest of the run, and do not touch mergePipeline.ts, which reads a fresh file once this lands.

When .taskTools/run-arguments.json does not exist, addTaskFiles.ts must succeed and change nothing; it is also run outside a pipeline run.

files: scripts/addTaskFiles.ts, scripts/prepareTasks.ts, tests/addTaskFiles.test.ts, tests/prepareTasks.test.ts

difficulty: around 3

RETARGETED 2026-08-09. This task was written against skills/tackle-tasks/plan.workflow.js, which is now dead code. Do not edit that file, and do not restore the old scope; it is deliberately narrower now.

WHY THE OLD SCOPE IS GONE. scripts/tackleTasksBrief.ts launches skills/tackle-tasks/task.workflow.js, passing it only task, stage, typecheckCommand, workerModel and maxRounds — explicitly not the run-arguments.json files snapshot. task.workflow.js's loadPreparedTask() re-reads tasks.json fresh at the start of every stage, and its widenFilesAndReplan() updates the in-memory files list right after addTaskFiles.ts runs. So the plan, verify and implement stages already see a widened fence. Nothing there needs fixing.

WHAT IS STILL BROKEN. scripts/prepareTasks.ts writes .taskTools/run-arguments.json once per run via resolveRunArgumentsPath, embedding each task's files array at groups[].tasks[].files. scripts/addTaskFiles.ts appends paths to tasks.json and stops there. The two then disagree for the rest of the run. scripts/mergePipeline.ts reads that snapshot: at lines 85-87 it refuses to archive a task declaring no files, and walks task.files to confirm the task's code landed before archiving. Against a stale, too-narrow list that gate verifies fewer files than the task owns.

THE FIX, IN ONE PLACE. addTaskFiles.ts already rewrites tasks.json; make it also refresh the snapshot. Import resolveRunArgumentsPath from scripts/prepareTasks.ts — export it if it is not exported yet — read .taskTools/run-arguments.json, and for every group and task in it, replace that task's files array with the task's files from the freshly written tasks.json. Write it back. Change no other field of the snapshot: not runId, not the manifest, not the branch names. A re-snapshot of the whole run would rewind runId and orphan the run in progress.

WHEN THERE IS NO SNAPSHOT. addTaskFiles.ts also runs outside a pipeline run, and update-task-files calls it. If .taskTools/run-arguments.json is absent, exit normally having changed nothing. Do not create it.

DO NOT edit scripts/mergePipeline.ts. It reads the file at use time and needs no change once the snapshot is accurate. Leaving it alone also keeps this task off the fence of anything touching the merge stage.

Evidence this is real, not theoretical: observed on task 144 during the 86 chain, and again on task 153 on 2026-08-09, where the orchestrator widened a fence mid-run and had to re-run prepareTasks.ts by hand to keep the later stages honest.

## Files

@scripts/addTaskFiles.ts
@scripts/prepareTasks.ts
@tests/addTaskFiles.test.ts
@tests/prepareTasks.test.ts