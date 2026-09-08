# Task 122: Dummy smoke task: create docs/dyn-inj-smoke.md

## User request

create a dummy task that I can use to see if the most recent commit that changed all tasks to be dyn-Inj-based works.

Throwaway payload task. Its only purpose is to be run end to end through /tackle-tasks to confirm the dynamically-injected brief-script skills still drive a full plan-implement-verify-merge cycle.

Context: commit 09c412b moved five SKILL.md bodies (close-tasks, create-task, merge-worktree-tasks, tackle-unblocked-tasks, update-task-files) into scripts/<name>Brief.ts, each SKILL.md collapsing to frontmatter plus one `!` injection block. Commit 85232c8 (task 75) did the same for tackle-tasks. The full set of brief scripts is now scripts/closeTasksBrief.ts, createTaskBrief.ts, mergeWorktreeTasksBrief.ts, reviewPlanBrief.ts, tackleTasksBrief.ts, tackleUnblockedTasksBrief.ts, taskStatsBrief.ts and updateTaskFilesBrief.ts.

The work: create docs/dyn-inj-smoke.md containing exactly one line, `dyn-Inj smoke test OK`. Nothing else. No existing file is touched, so a failed or partial run leaves no real diff to unwind.

Deliberately trivial so that any failure observed during the run belongs to the skill-injection pipeline rather than to this task's own difficulty. Delete docs/dyn-inj-smoke.md and close this task once the smoke run has been observed.

### docs/dyn-inj-smoke.md

(missing: file not found on disk)
