# Task 43 Plan: Rewrite pick-a-task's selection criteria to use the difficulty field

## Dependency note

This task is blocked by an as-yet-uncreated task that adds a `difficulty`
field (1-5) to tasks.json entries and to
`skills/create-task/template/taskTemplate.json`. This plan covers the
`SKILL.md` rewrite only, and assumes `getTaskDetails.ts` will surface
`difficulty` once that field exists on task entries (per the brief, no script
change is implied by task 43 itself — only the picking prose changes). Do not
start implementation until that blocking task is closed and task 43's
`blockedBy` is updated to reference it, per the brief's own instruction.

## Goal

Replace the prose-only "read every task and judge simplicity" step in
`skills/pick-a-task/SKILL.md` with a sort on the `difficulty` field. Keep
exactly one piece of prose judgment: the relevance check (is this task still
needed given the current codebase?) — difficulty cannot answer that, so it
can't be sorted away.

## Change

### skills/pick-a-task/SKILL.md

Keep the two existing shell lines unchanged (open tasks list, blocked
status). Replace the "Compare each open task... Pick the N easiest/simplest
open tasks..." block with:

1. Exclude any task reported as BLOCKED — unchanged rule, still applied
   first.
2. Pull full details for the remaining open, unblocked tasks in one call
   (`getTaskDetails.ts <N...>`) and sort by their `difficulty` field
   ascending; break ties by task number ascending. A task missing
   `difficulty` (not yet backfilled) sorts last rather than erroring.
3. Walking the sorted list from easiest, spend the one remaining prose
   judgment per candidate: is it still relevant to the current codebase (not
   already done, not obsoleted)? Skip irrelevant candidates and continue to
   the next-easiest. Stop once N relevant tasks are collected.
4. Report each picked task's number, title, difficulty, and the relevance
   reasoning — under 15 words per task. Do not start implementing any of
   them.

Leave the closing "start a session with..." / "prompt:" block and the
`$ARGUMENTS`/default-1 line unchanged — downstream tooling parses that exact
format.

### skills/pick-a-task/SKILL.md frontmatter description

Update the `description` line so the skill listing matches the new
mechanism, e.g.: "read the open, unblocked tasks in tasks.json, sort by
difficulty, and pick the N lowest-difficulty ones that are still relevant
(default 1), reporting why in under 15 words each."

## Out of scope

- Adding the `difficulty` field itself — that belongs to the blocking task,
  which also touches `taskTemplate.json` and tasks.json entries.
- Any change to `getTaskDetails.ts`, `checkBlockers.ts`, or other scripts.
- Any change to tasks.json data itself, including task 43's own `blockedBy`
  (added once the blocking task exists, per the brief).
- Changing `pick-a-task`'s `$ARGUMENTS` handling.

## Verification

After rewriting, re-read the new `SKILL.md` and confirm:
- The BLOCKED-exclusion rule still runs before the difficulty sort.
- Difficulty sort is the only ordering mechanism described (no leftover
  "reason about scope/ease" prose).
- Relevance check is the sole surviving prose judgment, applied per
  candidate while walking the sorted list, not to every open task upfront.
- The output contract (report format, closing session/prompt block) is
  byte-for-byte compatible with the original so `tackle-tasks`/`close-tasks`
  invocation still parses correctly.
- No test suite covers `SKILL.md` prose files (they are not executable
  code), so no automated test is added for this change.
