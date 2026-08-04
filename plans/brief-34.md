# Task 34: Archive only successfully published tasks

Phase 4 of the recursive repository-discovery redesign.

Create scripts/taskArchival.ts: return task-level merge results after successful publication and archive only the explicit task numbers whose integration was successfully published. The whole-run approval already authorizes finalization and archival, so no second post-merge approval is introduced.

A task in a conflicted, skipped, rolled-back, or partially published repository is never archived, and archival must be driven by an explicit list rather than by inferring success from the absence of errors.

Tests: a run where one logical repository rolled back archives none of that repository's tasks while archiving the successfully published ones; conflicted and skipped tasks stay open in tasks.json; archival requires the explicit published list; no second approval prompt is issued; archived entries land in completedTasks.json with their commit hashes.

### scripts/taskArchival.ts

(missing: file not found on disk)

### tests/taskArchival.test.ts

(missing: file not found on disk)
