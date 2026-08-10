# Task 183: Normalize the closing-task numbering in plans/ and add a drift check (audit C86-17)

## User request

Closing-task numbering is internally inconsistent. taken from /Users/matkatmusicllc/Programming/taskTools-86/plans/task-86-codex-audit.md. blocked by C86-16.

This is finding C86-17 (LOW) in plans/task-86-codex-audit.md.

The request and plan filename identify the closing task as 157, while the current spec (plans/task-86-spec.md) and the completed task data identify the closing work as task 163. No task 157 record corresponds cleanly to the plan, so task-to-commit and follow-up-audit traceability is ambiguous.

CAUSE: tasks 154-157 were renumbered to 160-163 to clear a collision with the new-usage-graph branch, which owns that range. The renumber updated tasks.json, completedTasks.json and the spec, but not the plan and brief filenames that had already been written.

DIRECTION settled with the user: rename the files and update the numbers inside them, rather than leaving the filenames and writing a renumbering footnote. Traceability should work without anyone having to find a note.

EXACTLY FOUR FILES DRIFT. A scan of plans/ against tasks.json plus completedTasks.json finds these naming a task number that no longer exists:

  plans/task-156-plan.md  -> task-162-plan.md
  plans/brief-156.md      -> brief-162.md
  plans/task-157-plan.md  -> task-163-plan.md
  plans/brief-157.md      -> brief-163.md

Both pairs come from the same renumber, so fix all four; renaming only the 157 pair leaves the drift check red. Update the task numbers written INSIDE each file too, not just the filenames. All four are untracked in git today.

The mapping for reference: 154->160, 155->161, 156->162, 157->163.

## Files

@plans/task-156-plan.md
@plans/brief-156.md
@plans/task-157-plan.md
@plans/brief-157.md
@plans/task-86-spec.md
### tests/planFileNumbering.test.ts

(missing: file not found on disk)
