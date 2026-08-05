# Task 43 Plan: Rewrite pick-a-task's selection criteria to use the difficulty field

## Goal
Replace the prose-based "read every task and judge simplicity" step in `skills/pick-a-task/SKILL.md` with a sort on the `difficulty` field. Per `skills/create-task/template/taskTemplate.json`, the scale is: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt. Keep exactly one piece of prose judgment: a relevance check (is this task still needed given the current codebase?), since relevance can't be sorted the way difficulty can.

No longer blocked — the `difficulty` field already exists on every open `tasks.json` entry, per the brief.

## Scope
Single file: `skills/pick-a-task/SKILL.md`. Only this file may be edited. `scripts/getTaskDetails.ts` and `scripts/checkBlockers.ts` are read-only inputs, referenced by their existing behavior below, and are not touched.

Confirmed by reading `scripts/getTaskDetails.ts`: called with no arguments it prints one `OPEN <n>: <title>[blockedBy: ...]` line per open task (no `difficulty`). Called with task numbers as arguments it prints the full JSON record per task, e.g. `task <n> (OPEN):\n{ ...full record including "difficulty"... }`. The rewrite below uses the existing multi-argument form to get every open task's `difficulty` — no script edit needed.

## Design

Old flow: list open tasks → agent reads every task in full and reasons in prose about scope/ease → picks N.

New flow:
1. List open tasks via the existing `getTaskDetails.ts | grep ^OPEN` and `checkBlockers.ts` bang commands (unchanged).
2. Exclude BLOCKED tasks.
3. For every remaining (non-blocked) open task number, pull its full record in one call — `getTaskDetails.ts <N...>` with all the numbers passed at once — and read each record's `difficulty` field from the returned JSON.
4. Sort those tasks by `difficulty` ascending (1 = easiest); break ties by task number ascending.
5. Walk the sorted list from the top. For each candidate, using the full record already pulled in step 3, do the one remaining judgment call: is it still relevant given the current state of the code (not already done, not obsoleted — check the files listed in its `files` field)? If yes, keep it; if no, skip it and move to the next-lowest-difficulty candidate.
6. Stop once N relevant tasks are collected, or the sorted list is exhausted. Exhaustion behavior: if 1 to N-1 tasks qualify, report them, state `Only <count> eligible relevant task(s) found.`, and still emit the closing lines using those task IDs. If zero qualify, output `No eligible relevant tasks found.` and omit the closing lines entirely — there are no valid task IDs to put in them.
7. Report: task number, title, difficulty digit, one-line relevance note — under 15 words each, as today.
8. End block (`start a session with...` / `prompt:` lines) and the `$ARGUMENTS`/default-1 line are unchanged — downstream tooling (`tackle-tasks`/`close-tasks`) parses that exact format.

This removes the "already partly done? one-file change? decision-only?" scope-guessing entirely — that guesswork is exactly what the difficulty rating now encodes. Relevance is the one thing left to check by hand, per the brief.

## New skills/pick-a-task/SKILL.md (target content)

```
---
name: pick-a-task
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 5=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
---

Number of tasks to pick: $ARGUMENTS (default 1 if blank or not a number).

Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`

Blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts"`

Exclude any task reported as BLOCKED in the "Blocked status" above — it is not eligible regardless of difficulty.

For every remaining (non-blocked) open task number, pull its full record in one call — `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` with all the numbers passed at once — and read each record's `difficulty` field (1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt).

Sort the remaining open tasks by difficulty ascending; break ties by task number ascending. This ordering replaces reasoning about scope; do not re-derive ease from reading the task body.

Starting from the lowest difficulty, for each candidate check the one thing difficulty can't tell you: is it still relevant given the current state of the code? Using the full record already pulled above, check the files listed in its `files` field — has this already been done, or does the premise no longer hold? Skip irrelevant candidates and continue down the sorted list.

Stop once you have N relevant tasks, or the sorted list is exhausted. Report to the user: each task's number, title, difficulty, and a one-line relevance note — under 15 words per task. Do not start implementing any of them.

If fewer than N tasks qualify, report the ones that do and add the line `Only <count> eligible relevant task(s) found.`, then end with the closing lines below using those task numbers. If no task qualifies, report `No eligible relevant tasks found.` and omit the closing lines — there are no task numbers to put in them.

Otherwise end your report with exactly:
`start a session with: 'claude --name "task <N...>"'`
`prompt: "/tackle-tasks [<N,...>] valid"`
where `<N...>` is the chosen task numbers space-separated, and `[<N,...>]` is the same numbers as a JSON array with no spaces (`[268,270]`) — the argument form tackle-tasks and close-tasks require.
```

## Verification
This is a prompt/instructions file, not executable code — there's no unit to test. Verify by dry-running the rewritten skill against the current `tasks.json` (once implemented) and confirming:
- The BLOCKED-exclusion rule still runs before the difficulty sort.
- Difficulty sort is the only ordering mechanism described (no leftover "reason about scope/ease" prose).
- Relevance check is the sole surviving prose judgment, applied per candidate while walking the sorted list, not to every open task upfront.
- Confirm `$ARGUMENTS` handling and the two closing-line templates remain unchanged; confirm each task entry now contains number, title, difficulty, and a relevance note.
- Confirm the exhaustion cases behave as specified: fewer than N qualifying tasks still emits the closing lines with those numbers, zero qualifying tasks emits neither.
- No automated test is added — SKILL.md is a prose/instructions file, not executable code.

## Out of scope
- Changing `difficulty` field semantics or the 1-5 scale itself (already defined in `skills/create-task/template/taskTemplate.json`).
- Any change to `getTaskDetails.ts` or `checkBlockers.ts`.
- Any change to `tackle-tasks`, `close-tasks`, or other consuming skills.
- Any change to tasks.json data itself.
