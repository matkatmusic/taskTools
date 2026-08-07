# Task 65: Add a split-task skill that breaks an oversized task into N smaller tasks

## User request

new skill 'split-task':  When a task description is particularly long or contains lots of steps or the task difficulty is high (above 3), allow splitting the task into smaller tasks at reasonable split points.  For example: task 58 should have been split into 'add readOnlyFiles: [*] to every task in tasks.json that is missing the key as part of 'close-tasks'" "add support for putting the readOnlyFiles values into the brief creation step" and "make 'close-tasks' rename 'files' in existing tasks.json to 'modifiableFiles", and "make create-task populate readOnlyFiles and modifiableFiles through subagent codebase research for the task being logged."

Invocation is `/split-task <taskNum> <numSplits>`, e.g. `split-task 58 4` — the split count is supplied by the user, not inferred. Declare it in SKILL.md front matter as `argument-hint: "<taskNum> <numSplits>"`, matching skills/create-task/SKILL.md line 4.

Skills in this repo are auto-discovered from skills/<name>/SKILL.md — .claude-plugin/plugin.json carries no skills array and there is no commands/ directory — so the new skill needs exactly one new file, skills/split-task/SKILL.md, with no manifest edit.

The task list lives at .taskTools/tasks.json (not the repo root). scripts/getTaskDetails.ts already resolves a task object by number and should be reused to load the parent rather than re-reading the file.

Child tasks must be created through the create-task skill — skills/create-task/SKILL.md line 3 declares itself the ONLY way to add a task and forbids direct tasks.json edits — so split-task invokes it once per child and never writes tasks.json itself. Each child inherits a subset of the parent's files array, and the union of the children's file lists must equal the parent's, so no declared file is orphaned by the split.

User decision on the parent: it is closed, not kept as a blocking umbrella, with closureNote "Split into <child numbers>". That closure must be deterministic for the fixture test to assert on, which is why this task is blocked by task 64 (scripts/closeTasks.ts); split-task's backing script calls closeTasks() instead of hand-editing JSON, the same way scripts/taskArchival.ts writes both files with JSON.stringify(..., null, 2) + "\n".

The deterministic parts — reading the parent, partitioning its files across N children, closing the parent with the composed note — belong in a new scripts/splitTask.ts so tests/splitTask.test.ts can round-trip them on temp fixture files; only choosing the split points stays agentic in SKILL.md.

Trigger heuristic to document in SKILL.md: difficulty above 3, or a description with many enumerated steps. The 1–5 difficulty scale is defined in skills/create-task/template/taskTemplate.json and is currently read only by skills/pick-a-task/SKILL.md. Add a pointer in skills/create-task/SKILL.md so that when it is about to write difficulty 4 or 5 it offers split-task instead.

### skills/split-task/SKILL.md

(missing: file not found on disk)

### scripts/splitTask.ts

(missing: file not found on disk)

### skills/create-task/SKILL.md

```
---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
---

- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`

Task described by the user: $ARGUMENTS

Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:

```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `userDescription` with $ARGUMENTS verbatim, exactly as typed — never edit, summarize, or reword it. Populate `description` with only the agent's derived understanding gathered while writing the task: file paths, line numbers, root-cause findings, constraints, and decisions; it must not restate the raw prompt.

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.

If `specs/SPEC.md` exists and this task belongs to one of its spec items, append the task number to that item's `Tasks:` line.

Omit completion-related fields (`completionDate`, `commitHashes`, `closureNote`) — those belong to `completedTasks.json`, which this skill never touches.

Finally, confirm to the user: the task number and title that were added.

```

### tests/splitTask.test.ts

(missing: file not found on disk)
