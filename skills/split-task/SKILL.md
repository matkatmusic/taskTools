---
name: split-task
description: Break an oversized open task into N smaller child tasks at reasonable split points. Trigger when a task's difficulty is above 6, or its description lists many enumerated steps, and it would be clearer as several smaller tasks.
argument-hint: "<taskNum> <numSplits> [guidance]"
---

- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $ARGUMENTS[0] $ARGUMENTS[1]`

Parent task number: $ARGUMENTS[0]. Number of children to create: $ARGUMENTS[1].

Guidance (optional): take the raw `$ARGUMENTS` for this invocation and strip its first two whitespace-delimited tokens (the task number and the split count) from the front. Whatever text remains, with its internal spacing preserved exactly, is the guidance string — do not use the third positional substitution, which captures only the first remaining word and would silently truncate a multi-word guidance. If nothing remains after stripping the first two tokens, there is no guidance for this invocation.

The command above printed the parent task's full record and the $ARGUMENTS[1] file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $ARGUMENTS[1] ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. If guidance was given, use it to decide both $ARGUMENTS[1] reasonable split points in the parent's work and which of the parent's files belong to each split point: the file groups printed above are only a suggested starting point, not the final grouping, and you may reassign files across children to match the guidance as long as every parent file ends up in exactly one child's group and no child claims a file the parent doesn't have. If no guidance was given, decide $ARGUMENTS[1] reasonable split points in the parent's work and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on, unchanged from the command's output. Either way, write down each child's final file list now — it is what you will pass to `/create-task` below and to the `close` command afterward.

For each of the $ARGUMENTS[1] children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $ARGUMENTS[1] children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's final file list, decided above>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 7 or higher and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file lists you decided above.

If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($ARGUMENTS[0]) is still open and was not closed, so the user can decide how to clean up the partial children.

Once all $ARGUMENTS[1] children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas (IN THE SAME ORDER as the file lists you decided above), and replacing `<shellQuotedFileGroupsJson>` as follows: first build the JSON text — a JSON array of arrays, one array of file paths per child in that same order, containing exactly the final file list you assigned to that child. Then, because that JSON text is about to sit on a shell command line where a `'` character inside a file path would otherwise break the command, make it shell-safe: replace every `'` character in the JSON text with the four characters `'"'"'`, then wrap the whole result in one leading and one trailing `'` character. That wrapped, escaped result — not the raw JSON — is what you substitute for `<shellQuotedFileGroupsJson>`; do not add another pair of quotes around it.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $ARGUMENTS[0] $ARGUMENTS[1] <childNumbers> <shellQuotedFileGroupsJson>
```

This re-validates the child numbers, checks that the file groups decoded from `<shellQuotedFileGroupsJson>` exactly partition the parent's current `files` array (no file assigned to more than one child, no file outside the parent's list, no parent file missing from every group), then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because the decoded file groups don't partition the parent's files, or because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child or file mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.

Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.
