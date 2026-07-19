---
name: update-tasks
description: scan plans/ implementation notes and handoffs for open items/questions, add them to tasks.json, then archive the notes into plans/archived/
---

First, invoke `/ponytail:ponytail ultra`.

Then:

1. Files to process: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts" --list`

2. Extracted open-work sections (every `### Open questions` section from implementation notes, the `## What Remains` section from handoffs; each under a `=== <file> ===` banner): 
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts"`


   Apply judgment to the extracted text above: skip items the section itself marks as resolved (e.g. "None blocking"), and skip empty sections.

3. **De-duplicate.** Before adding, check both `tasks.json` and `completedTasks.json` (titles and descriptions) for an existing task covering the same item. If an open item belongs to an existing open task, extend that task's `description` (and add the source file to its `handoffFilePaths`) instead of creating a duplicate.
Titles: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts"`

4. **Create each new task via the `create-task` skill** — one Skill-tool invocation per task, sequentially (each invocation injects the then-current next taskNumber). Pass as args: a short title, the open item in the source file's own wording (with enough context to act on it later — file paths, item numbers), and the source file's **archived** path (e.g. `plans/archived/implementation-notes-item66-fork-style-port.md`) to record as `handoffFilePaths`. The wording is already refined here — create-task should not need AskUserQuestion. If the Skill tool is unavailable, append directly to `tasks.json` in the same format instead (`taskNumber` = run `node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"` before each append, `title`, `description`, `handoffFilePaths`; omit completion-related fields).

5. **Archive the processed files**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/archiveProcessed.ts" <the step-1 file list>`. It moves each given file into `plans/archived/` (a file that yielded no new tasks is still retired by processing it) and leaves any file in place whose name already exists in `plans/archived/`, printing `COLLISION` for it — report those collisions.

Finally, report a short table: each archived file → the task numbers created from it (or "none / duplicate of task N"). 
Stage the changes but do not commit. Use a subagent running `Sonnet 5` to generate a short (40 words or less) single-sentence summary of the work done, and show that summary to the user, so the user can use it as a commit message.
