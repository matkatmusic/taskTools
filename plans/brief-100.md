# Task 100: Widen the difficulty scale definition from 1-5 to 1-10 across the skill prose

## User request

[split-task-child] This task is being created by `/split-task` as one of an already-requested set of 3 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `skills/pick-a-task/SKILL.md`, `skills/create-task/template/taskTemplate.json`, `skills/split-task/SKILL.md`.

TITLE: Widen the difficulty scale definition from 1-5 to 1-10 across the skill prose

This is child 2 of 3 split out of parent task 66 ("Widen the difficulty scale from 1-5 to 1-10 and add a rate-task skill that scores difficulty and split-worthiness"). Child 1 (task 99) remaps the already-stored numbers; this child rewrites the human-readable scale definitions so new tasks are rated on the widened scale. Child 3 builds the rate-task skill.

WHAT TO DO: the 1-5 anchors are spelled out in prose in exactly these places, and all of them must be rewritten with ten anchors:

1. skills/create-task/template/taskTemplate.json line 8 — the `difficulty` template comment, currently `1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt`. Replace with ten distinct anchors spanning the same span of effort and risk, so that the old anchors land on their doubled positions: the old 1 anchor becomes the new 2, old 2 becomes 4, old 3 becomes 6, old 4 becomes 8, old 5 becomes 10, and the five odd-numbered slots get new intermediate anchors. This keeps the anchors consistent with child 1's doubling remap, so a task rated 6 today means the same thing as a task rated 3 yesterday.

2. skills/pick-a-task/SKILL.md line 3 — the front-matter `description`, currently reads `sort by difficulty (1=easiest, 5=hardest)`. Must become 1=easiest, 10=hardest.

3. skills/pick-a-task/SKILL.md line 14 — the inline anchor list repeating the same 1-5 definitions. Must be rewritten to match the new ten anchors in taskTemplate.json exactly, word for word, so the two copies cannot drift apart.

4. skills/split-task/SKILL.md — its trigger prose currently says split-task fires when "a task's difficulty is above 3". On the widened scale that threshold must move to above 6, otherwise every remapped task suddenly looks oversized. Check both the front-matter `description` and any repetition of the threshold in the skill body, and update every occurrence.

CONSTRAINTS: no script reads or validates the numeric bound — skills/pick-a-task/SKILL.md only sorts ascending on line 16 — so widening the scale needs no code change, only these prose definitions. Do not add validation. Line numbers cited above were accurate when parent 66 was written; verify them before editing rather than trusting them.

Do NOT edit .taskTools/tasks.json or .taskTools/completedTasks.json in this child — the stored numbers are child 1's (task 99) job.

TESTS: skip.

DIFFICULTY: 2 on the OLD 1-5 scale.

BLOCKED BY: nothing. It is independent of child 1 (task 99); the two touch disjoint files, though merging both before rating any new task keeps the numbers coherent.

Child 2 of 3 split from parent task 66. Pure prose/definition work: this child changes what the numbers MEAN, child 1 (task 99) changes the numbers already stored, child 3 adds the rate-task skill that produces new ones.

The 1-5 anchors are duplicated in three skill files and nowhere else:

- skills/create-task/template/taskTemplate.json, the `difficulty` template comment (line 8 at the time parent 66 was written) — the canonical anchor list.
- skills/pick-a-task/SKILL.md front-matter `description` (line 3), which states `sort by difficulty (1=easiest, 5=hardest)`.
- skills/pick-a-task/SKILL.md inline anchor list (line 14), a verbatim second copy of the taskTemplate anchors.
- skills/split-task/SKILL.md, whose trigger prose fires on "difficulty above 3".

Anchor placement decision: the ten new anchors must be positioned so the old five land on their doubled slots — old 1 → new 2, old 2 → new 4, old 3 → new 6, old 4 → new 8, old 5 → new 10 — with new intermediate anchors filling 1, 3, 5, 7, 9. This is what makes child 1's doubling remap semantically correct rather than an arbitrary rescale; a task carrying 6 after the remap must read the same as a task that carried 3 before it.

split-task's threshold has to move with the scale: "above 3" on the old scale is "above 6" on the new one. Left unchanged, every task child 1 remaps would trip the oversized heuristic. Both the front-matter description and any body repetition of the threshold need updating.

No code change is required. Nothing validates or bounds the numeric value; pick-a-task's script only sorts ascending. Adding validation is explicitly out of scope.

The two pick-a-task copies must stay word-for-word identical to the taskTemplate copy so they cannot drift.

Cited line numbers were accurate as of parent 66 and should be re-verified before editing. Unblocked and file-disjoint from task 99.

### skills/pick-a-task/SKILL.md

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

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "version": "<the injected commit hash above>",
  "title": "<short summary of the task>",
  "userDescription": "<$ARGUMENTS verbatim, exactly as typed — never edited, summarized, or reworded>",
  "description": "<only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints, and decisions gathered while writing the task; must not restate the raw prompt>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [{"taskNum": <task number that must be completed first>, "reason": "<required: why this task depends on it>"}] (one object per blocking task; omit the field entirely if none)
}

```

### skills/split-task/SKILL.md

```
---
name: split-task
description: Break an oversized open task into N smaller child tasks at reasonable split points. Trigger when a task's difficulty is above 3, or its description lists many enumerated steps, and it would be clearer as several smaller tasks.
argument-hint: "<taskNum> <numSplits> [guidance]"
---

- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $ARGUMENTS[0] $ARGUMENTS[1]`

Parent task number: $ARGUMENTS[0]. Number of children to create: $ARGUMENTS[1].

Guidance (optional): take the raw `$ARGUMENTS` for this invocation and strip its first two whitespace-delimited tokens (the task number and the split count) from the front. Whatever text remains, with its internal spacing preserved exactly, is the guidance string — do not use the third positional substitution, which captures only the first remaining word and would silently truncate a multi-word guidance. If nothing remains after stripping the first two tokens, there is no guidance for this invocation.

The command above printed the parent task's full record and the $ARGUMENTS[1] file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $ARGUMENTS[1] ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. If guidance was given, use it to decide both $ARGUMENTS[1] reasonable split points in the parent's work and which of the parent's files belong to each split point: the file groups printed above are only a suggested starting point, not the final grouping, and you may reassign files across children to match the guidance as long as every parent file ends up in exactly one child's group and no child claims a file the parent doesn't have. If no guidance was given, decide $ARGUMENTS[1] reasonable split points in the parent's work and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on, unchanged from the command's output. Either way, write down each child's final file list now — it is what you will pass to `/create-task` below and to the `close` command afterward.

For each of the $ARGUMENTS[1] children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $ARGUMENTS[1] children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's final file list, decided above>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file lists you decided above.

If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($ARGUMENTS[0]) is still open and was not closed, so the user can decide how to clean up the partial children.

Once all $ARGUMENTS[1] children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas (IN THE SAME ORDER as the file lists you decided above), and replacing `<shellQuotedFileGroupsJson>` as follows: first build the JSON text — a JSON array of arrays, one array of file paths per child in that same order, containing exactly the final file list you assigned to that child. Then, because that JSON text is about to sit on a shell command line where a `'` character inside a file path would otherwise break the command, make it shell-safe: replace every `'` character in the JSON text with the four characters `'"'"'`, then wrap the whole result in one leading and one trailing `'` character. That wrapped, escaped result — not the raw JSON — is what you substitute for `<shellQuotedFileGroupsJson>`; do not add another pair of quotes around it.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $ARGUMENTS[0] $ARGUMENTS[1] <childNumbers> <shellQuotedFileGroupsJson>
```

This re-validates the child numbers, checks that the file groups decoded from `<shellQuotedFileGroupsJson>` exactly partition the parent's current `files` array (no file assigned to more than one child, no file outside the parent's list, no parent file missing from every group), then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because the decoded file groups don't partition the parent's files, or because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child or file mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.

Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.

```
