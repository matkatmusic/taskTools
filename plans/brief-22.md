# Task 22: Task grouping over canonical effects instead of raw paths

Phase 3 of the recursive repository-discovery redesign.

Create scripts/canonicalTaskGroups.ts: group tasks by union over canonical ownership and effect paths from scripts/ownershipKeys.ts rather than the literal declared file strings used by scripts/taskGroups.ts. Repository identity discovery must be complete before final grouping and worktree creation.

Tasks naming the same logical file through different occurrences must land in one serial group. Tasks touching genuinely disjoint files may remain in parallel groups even when those files belong to the same logical repository.

New module only — do not modify scripts/taskGroups.ts or scripts/prepareTasks.ts; the Phase 4 cutover task routes production through this module.

Tests: two tasks naming the same logical file through different occurrence paths union into one group; two tasks touching disjoint files in one logical repository stay in separate groups; overlap introduced only by ancestor-gitlink effects still unions; grouping is deterministic and group IDs are stable for a given task set.

### scripts/canonicalTaskGroups.ts

(missing: file not found on disk)

### tests/canonicalTaskGroups.test.ts

(missing: file not found on disk)
