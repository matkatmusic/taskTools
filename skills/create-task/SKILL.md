---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
---

- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`
- version to use: !`git rev-parse HEAD`

Task described by the user: $ARGUMENTS

Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Skip this oversized-task assessment entirely when this invocation of `/create-task` carries the marker `[split-task-child]` (see `skills/split-task/SKILL.md`) — that marker means `/split-task` is creating one of an already-requested set of children, and offering another split here would stop `/split-task` from collecting exactly `numSplits` child task numbers. Otherwise, assess whether this task is oversized: would its difficulty (on the template's 1–5 scale) be 4 or 5, or does its description read as a list of many enumerated steps rather than one piece of work? If so, invoke AskUserQuestion offering two choices: create this task as a single task, or create it and immediately split it into smaller tasks. If the user chooses to split, invoke AskUserQuestion once more to get an integer number of children, at least 2. Continue with the steps below to create this task as normal (it becomes the parent) — once it has been appended and its task number is known, invoke `/split-task <thisTaskNumber> <numSplits>` immediately, and let its own closing confirmation replace the "Finally, confirm" step below.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:

```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `userDescription` with $ARGUMENTS verbatim, exactly as typed — never edit, summarize, or reword it. Populate `description` with only the agent's derived understanding gathered while writing the task: file paths, line numbers, root-cause findings, constraints, and decisions; it must not restate the raw prompt.

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

Populate `version` with the injected commit hash above. If that value is not a 40-character hexadecimal string — for example when `git rev-parse HEAD` failed because the repository has no commits yet — omit the field entirely.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.

If `specs/SPEC.md` exists and this task belongs to one of its spec items, append the task number to that item's `Tasks:` line.

Omit completion-related fields (`completionDate`, `commitHashes`, `closureNote`) — those belong to `completedTasks.json`, which this skill never touches.

Finally, confirm to the user: the task number and title that were added.
