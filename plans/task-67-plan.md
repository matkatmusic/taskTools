# Task 67 Plan: Add a `version` key to every new task

## Goal

`create-task` records a new `version` field on every task it appends to
`tasks.json`, populated from the active repo's `HEAD` commit hash. Write-only:
no reader, validator, or backfill. Two files change.

## Owned-file disposition

- `skills/create-task/SKILL.md` — edited (two additions, below).
- `skills/create-task/template/taskTemplate.json` — edited (one addition, below).
- `scripts/splitTask.ts` — does not exist on disk (confirmed via `fd`/`ls`;
  no git history for the path either). No edit: nothing to change, and it
  is not one of the two files the brief names as changing.
- `skills/split-task/SKILL.md` — does not exist on disk (same check). No
  edit, same reason. This is the "split-task skill from task #65" the brief
  mentions only to explain why it needs no edit — it would route through
  `create-task` and inherit the new key automatically once it exists; that
  is not part of this task's scope.
- `tests/createTaskVersion.test.ts` — does not exist on disk. No edit: this
  task carries no `tests` field requiring a test file (ordinary verification
  commands are used instead, per this plan's Verification section).
- `tests/splitTask.test.ts` — does not exist on disk. Same reasoning as
  `scripts/splitTask.ts` above: nothing to change.

## Edit 1 — `skills/create-task/SKILL.md`

### 1a. Add the `version` injection line

Current line 7 (unchanged, stays in place):
```
- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`
```

Insert a new line immediately after it, so the file reads:
```
- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`
- version to use: !`git rev-parse HEAD`
```

This uses the shell injection directly (no new script), runs with the
user's project as its working directory (the repo whose `HEAD` is wanted),
and records the full 40-character hash.

### 1b. Add the `Populate version` instruction paragraph

Current text (lines 23–25, exact, with the blank lines that separate
paragraphs):
```
Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.
```

Replace with (inserts one new paragraph, with its own blank-line spacing,
between the two existing ones):
```
Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

Populate `version` with the injected commit hash above. If that value is not a 40-character hexadecimal string — for example when `git rev-parse HEAD` failed because the repository has no commits yet — omit the field entirely.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.
```

This resolves both edge cases named in the brief: a detached HEAD needs no
special handling because `git rev-parse HEAD` still succeeds and prints the
correct 40-character hash there, so it falls straight through the normal
path; a zero-commit repo makes the command fail and print to stderr, so its
injected value will not be a 40-character hex string, and the new sentence
tells the agent to omit the field in that case, matching the existing
omit-when-undeterminable convention already used for `files` two paragraphs
above and `blockedBy` in the template.

Net effect on `skills/create-task/SKILL.md`: 31 lines → 34 lines (1 line
added in step 1a, 2 lines added in step 1b — one new paragraph line plus
its separating blank line).

## Edit 2 — `skills/create-task/template/taskTemplate.json`

Current lines 1–3 (exact):
```
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
```

Replace with:
```
{
  "taskNumber": <the injected number above>,
  "version": "<the injected commit hash above>",
  "title": "<short summary of the task>",
```

`version` sits next to `taskNumber` (now lines 2–3) since both are
machine-supplied rather than authored, ahead of every author-facing field.
It is quoted as a string placeholder (unlike `taskNumber`, which is a bare
number placeholder) because a commit hash is a string, matching the
quoting style already used for `title`, `userDescription`, etc.

Net effect: `skills/create-task/template/taskTemplate.json` grows from 10
lines to 11 lines; no other line changes.

## Order of operations

1. Apply Edit 1a to `skills/create-task/SKILL.md`.
2. Apply Edit 1b to `skills/create-task/SKILL.md`.
3. Apply Edit 2 to `skills/create-task/template/taskTemplate.json`.
4. Run verification below.

No other files are touched. No test file is created (this task has no
`tests` field requiring one).

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools`).

1. Injection line present and correctly placed:
   ```
   rg -n 'version to use' skills/create-task/SKILL.md
   ```
   Expected: one match —
   `8:- version to use: !`git rev-parse HEAD``

2. Populate-version paragraph present:
   ```
   rg -n 'Populate `version`' skills/create-task/SKILL.md
   ```
   Expected: one match, the sentence from step 1b above.

3. Template gains the `version` key in the right place:
   ```
   rg -n '"version"' skills/create-task/template/taskTemplate.json
   ```
   Expected: one match —
   `3:  "version": "<the injected commit hash above>",`

4. No unintended line changes — exact diff shape:
   ```
   git diff --stat -- skills/create-task/SKILL.md skills/create-task/template/taskTemplate.json
   ```
   Expected: both files listed, `SKILL.md` shows 3 insertions / 0
   deletions, `taskTemplate.json` shows 1 insertion / 0 deletions.

5. Line counts match the new totals:
   ```
   wc -l skills/create-task/SKILL.md skills/create-task/template/taskTemplate.json
   ```
   Expected: `SKILL.md` = 34, `taskTemplate.json` = 11.

6. The four nonexistent owned files remain untouched (still absent, no
   stray creation):
   ```
   git status --porcelain -- scripts/splitTask.ts skills/split-task/SKILL.md tests/splitTask.test.ts tests/createTaskVersion.test.ts
   ```
   Expected: empty output.

7. No other file in the repo was modified by this change:
   ```
   git diff --name-only -- skills/ scripts/ tests/
   ```
   Expected: exactly two paths —
   `skills/create-task/SKILL.md`
   `skills/create-task/template/taskTemplate.json`
