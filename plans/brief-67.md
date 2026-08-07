# Task 67: Add a version key to every new task, set by create-task to the active branch's HEAD commit hash

## User request

a task needs a 'version' key.  'create-task' should provide it. version comes from the latest commit hash of the active branch.  parsing of tasks based on version key value comes later, in a separate codebase addition.

Scope is deliberately write-only: create-task records the key, nothing reads it yet. No consumer, no validation, no backfill of the tasks already in .taskTools/tasks.json — a task without a version key stays without one, and every reader must tolerate its absence. The `version` key does not appear anywhere in .taskTools/tasks.json today.

Two files change. skills/create-task/template/taskTemplate.json gains a `"version"` entry (place it next to `taskNumber` at line 2, since both are machine-supplied rather than authored). skills/create-task/SKILL.md gains two lines: an injection alongside the existing one at line 7 — line 7 is currently `- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`` — plus a "Populate `version` with ..." instruction near the existing ones at lines 21-23.

Use the shell injection `!`git rev-parse HEAD`` directly rather than adding a script under scripts/. Nothing needs resolving the way nextTaskNumber.ts resolves the task-file location; it is one git command, and the injection already runs with the user's project as its working directory, which is the repo whose HEAD is wanted — not the plugin's own repo. Record the full 40-character hash, not an abbreviation, so it stays unambiguous as history grows.

Two edge cases the implementer must decide in the SKILL.md prose, not leave to the agent at runtime: a repository with zero commits (`git rev-parse HEAD` exits non-zero and prints to stderr) and a detached HEAD (the command still succeeds and the hash is still the right answer, so only the empty-repo case needs a fallback). Note that scripts/prepareTasks.ts already refuses to run against a repo with no origin remote, but that guard does not cover the no-commits case here.

Every other task-creating surface — skills/update-tasks, skills/goal-tasks, and the split-task skill from task #65 — routes through create-task rather than writing tasks.json directly, so they inherit the key with no edits of their own.

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

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "userDescription": "<$ARGUMENTS verbatim, exactly as typed — never edited, summarized, or reworded>",
  "description": "<only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints, and decisions gathered while writing the task; must not restate the raw prompt>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}

```

### tests/createTaskVersion.test.ts

(missing: file not found on disk)
