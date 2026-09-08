# Amendment: Task 28 plan — PostToolUse hook proves a Workflow launch is live from the run log

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/28-task.md
- Reviewed against: /Users/matkatmusicllc/.claude/tasks/taskTools-86/28.json and the live tackle-tasks workflow and skill
Sections: 5 | Fixes: 3
Efficacy: 40%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/28-task.md must be amended with the fixes below, then re-reviewed before use. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. The newest existing log is not evidence of this Workflow launch

- Evidence: `[plans/pipeline-audit-20260905-114658/28-task.md:53-81, plans/pipeline-audit-20260905-114658/28-task.md:123-137]`
- The plan claims: printing the newest task log's first entry proves that the Workflow call that just returned started running blocks.
- Actually true: the hook does not correlate a file with the current tool call, workflow invocation, run ID, or even a lower-bound timestamp. If task 7 has an old log and a new Workflow launch fails before writing anything, the proposed hook selects the old file and reports `PREAMBLE_STATUS_CHECK` as proof that the failed launch is live. The “multiple logs” test positively codifies selection of stale state rather than current-call correlation.

### 2. Log discovery trusts hook cwd instead of the Workflow's tasks file

- Evidence: `[plans/pipeline-audit-20260905-114658/28-task.md:37-43, plans/pipeline-audit-20260905-114658/28-task.md:115-137]`
- The plan claims: `join(payload.cwd, ".taskTools", "runs")` is the target task's run directory.
- Actually true: the tool input already carries the authoritative absolute `args.tasksFile`, but the implementation ignores it. A globally installed skill can be called while the session cwd is a worktree, subdirectory, or different repository; the hook then searches the wrong `.taskTools/runs` and can report either no log or another project's log.

### 3. Empty or corrupt logs make the observational hook fail

- Evidence: `[scripts/runStepHook.ts:120-128, scripts/runStepHook.ts:203-208, plans/pipeline-audit-20260905-114658/28-task.md:123-141]`
- The plan claims: the hook prints either a first block or the no-log message.
- Actually true: current run logs are rewritten non-atomically, and the proposed expression blindly parses the selected file, indexes element zero, and dereferences `.block`. Empty JSON, a truncated write, a non-array, or an empty array throws from a PostToolUse hook instead of returning diagnostic context.

## Durable fixes

### Fix for issue 1

- Change: Introduce a launch correlation value created for each Workflow call and persisted in the first run record/log entry, then require an exact match in the PostToolUse hook. If the Workflow interface cannot carry such a value, report only “latest observed log” with its age/path and stop claiming current-launch liveness. Add a stale-prior-log/new-launch-failure test.
- Durable because: Evidence is bound to the event being evaluated rather than inferred from residue of an earlier run of the same task.

### Fix for issue 2

- Change: Validate `tool_input.args.tasksFile`, derive its project root using the repository's task-file helpers, and search that root. Add a test whose payload cwd is an unrelated directory while `tasksFile` points at the fixture repo.
- Durable because: Global use no longer depends on the caller's incidental working directory.

### Fix for issue 3

- Change: Read the candidate defensively and emit explicit context for unreadable, non-array, empty, or entry-without-block logs; do not make an observational hook throw for pipeline-owned partial state. Add a fixture for each case and for replacement during read.
- Durable because: The liveness diagnostic stays available during the crash and write-interruption conditions it is meant to diagnose.

## Sections that hold up

- A `Workflow` matcher is not currently registered — verified against `hooks/hooks.json:41-74`
- The proposed hook output uses the repository's existing `hookSpecificOutput.additionalContext` shape — verified against `scripts/taskTestsHook.ts:8-23`
- Task-specific filenames can be recognized unambiguously in the current flat runs directory — verified against `scripts/runStepHook.ts:40-44`
