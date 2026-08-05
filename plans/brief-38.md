# Task 38: tackle-tasks-loop skill

another mode that keeps checking the tasks.json for blockers on a timer,tackles them, then does unblocked until the whole list is completed.  End result of this script-loop running is that the user just has to run it once, then just use 'create-task' or 'goal-tasks' to define what to build, and the background agents build everything that has a task created. 

Create skills/tackle-tasks-loop/SKILL.md only — skills are auto-discovered by directory, so no plugin.json or marketplace.json registration is needed. The skill wraps the existing global `/loop` skill to invoke `taskTools:tackle-tasks unblocked` (task 37's mode) on an interval. Use scripts/taskStats.ts for the stop condition: end when the open count reaches 0, and bail out when a full pass finds nothing unblocked so it does not spin on a fully blocked backlog. No new TypeScript and no new test file — checkBlockers.ts --unblocked and taskStats.ts already supply every count this needs.

### skills/tackle-tasks-loop/SKILL.md

(missing: file not found on disk)
