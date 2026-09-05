# Amendment: Task 12 plan — ship the ignore-pattern fix to every seed path, not just brand-new projects

- Plan reviewed: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/12-task.md
- Reviewed against: the live tackle-tasks codebase and task 12 requirements
Sections: 5 | Fixes: 1
Efficacy: 80%
Ruling: /Users/matkatmusicllc/Programming/taskTools-86/plans/pipeline-audit-20260905-114658/12-task.md can be used after incorporating the fix below. Keep your edits small. Do not state that the edits are the result of feedback from an amendment.

## Issues

### 1. Unconditional gitignore seeding is not concurrency-safe

- Evidence: `[plans/pipeline-audit-20260905-114658/12-task.md:104-124, scripts/taskFiles.ts:42-60, scripts/taskStateLock.ts:18-52, tests/taskFiles.test.ts:74-110]`
- The plan claims: `seedGitignore` is idempotent, so calling it unconditionally before the existing task-state lock is sufficient.
- Actually true: its read/filter/append sequence is idempotent only serially. Concurrent first-run seeders can all observe the patterns as missing and append duplicate blocks. The repository already has a 16-process seeding test and a lock that can serialize the gitignore update, but the proposed call remains outside that lock and the test does not assert pattern uniqueness.

## Durable fixes

### Fix for issue 1

- Change: Create the task directory, acquire `withTaskStateLock`, and call `seedGitignore(taskFilesProjectRoot(pair))` inside the same critical section before seeding the JSON files. Extend the existing concurrent-seeders test to read `.gitignore` and assert each default pattern occurs exactly once.
- Durable because: both task-file initialization and project ignore migration become one serialized, repeatable seed transaction, and the existing race fixture guards it.

## Sections that hold up

- The missing patterns and established-project call-site gap are correctly identified — verified against `scripts/taskFiles.ts:40-60`
- `taskFilesProjectRoot` handles housed and legacy task layouts — verified against `scripts/taskFiles.ts:18-23`
- The two proposed ignore patterns match the generated artifact locations — verified against `scripts/tackle-tasks/shared/checkpoint.ts:19-32` and `plans/pipeline-audit-20260905-114658/10-task.md:405-415`
