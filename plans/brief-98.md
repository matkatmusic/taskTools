# Task 98: close-tasks drains the legacy files key by renaming it to modifiableFiles on every invocation

## Goal

**This task is considered done when all of these are true:**

- every close-tasks run renames any remaining `files` key to `modifiableFiles` in tasks.json
- the rename changes nothing else: no reorder, no renumber, no other key touched
- a task that declares no `readOnlyFiles` does not gain one
- a task already declaring `modifiableFiles` is left untouched
- a task declaring both keeps `modifiableFiles`, drops `files`, and the two lists are never merged

## User request

[split-task-child] This task is being created by `/split-task` as one of an already-requested set of 6 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `["skills/close-tasks/SKILL.md"]`.

Child 6 of 6 from parent task 58 ("Split task file ownership into modifiableFiles and readOnlyFiles, and make briefs point at files instead of pasting them"). This child owns STEP 6: when close-tasks is invoked, replace 'files' with 'modifiableFiles' in the project's tasks.json.

Required behavior:
1. Add a migration step to skills/close-tasks/SKILL.md: on each invocation, rename any remaining 'files' key to 'modifiableFiles' across the project's tasks.json, so the legacy key drains out over time even though readers still accept it.
2. The migration is a rename only — it must not reorder tasks, renumber them, touch any other key, or invent a readOnlyFiles value for a task that does not declare one. A task with no readOnlyFiles keeps having none, and the accessor's ["*"] default covers it at read time.
3. A task that already declares 'modifiableFiles' is left alone. If a task somehow declares both keys, keep 'modifiableFiles' and drop the legacy 'files' — never merge the two lists.
4. This migration is why readers must keep accepting the legacy key: the two must ship together, or a half-migrated tasks.json breaks.

Do NOT edit scripts/prepareTasks.ts, scripts/taskGroups.ts, scripts/approvalGate.ts, scripts/mergePipeline.ts, any skills/tackle-tasks/ file, skills/create-task/SKILL.md, skills/create-task/template/taskTemplate.json, skills/update-task-files/SKILL.md, or any tests/ file — those belong to siblings.

Files: skills/close-tasks/SKILL.md

Tests: run close-tasks against a tasks.json holding one legacy task declaring only 'files', one task already declaring 'modifiableFiles', and one declaring both. Assert the legacy task's key is renamed with its list unchanged, the already-migrated task is untouched, the both-keys task keeps modifiableFiles and loses files with no list merging, no task gains a readOnlyFiles key it did not have, and task order and numbering are unchanged.

Difficulty: 2

Step 6 of the 6-way split of task 58, and the one that makes the rename eventually complete. Scope is skills/close-tasks/SKILL.md only.

The strategy: readers accept both keys forever (the shared accessor in scripts/prepareTasks.ts falls back to `files`), so nothing breaks mid-migration, and close-tasks does an opportunistic rename on every invocation so the legacy key drains out of tasks.json over normal use instead of needing a flag-day rewrite. That is why this child and the reader-fallback child must both land — the fallback without the drain leaves the old key forever, and the drain without the fallback breaks any task not yet migrated.

Rename-only constraints, all of which are ways this could quietly corrupt tasks.json: no reordering, no renumbering, no touching any other key, and specifically no inventing a readOnlyFiles value for a task that does not declare one. An absent readOnlyFiles is meaningful — the accessor resolves it to ['*'] at read time — so materialising it here would freeze a default that should stay implicit.

Collision handling: a task already carrying modifiableFiles is left alone. A task carrying both keys keeps modifiableFiles and drops files, with no merging of the two lists — merging would silently widen an edit fence, which is the one thing this whole change exists to keep narrow.

close-tasks already rewrites tasks.json when it moves closed tasks to completedTasks.json, so the migration rides along on a write that is already happening rather than adding a new pass.

Related memory: close-tasks runs its archiving bookkeeping in a subagent while the verification gate stays in the main agent — the migration belongs with the bookkeeping half.

## Files

@skills/close-tasks/SKILL.md