---
name: split-task
description: Break an oversized open task into N smaller child tasks at reasonable split points. Trigger when a task's difficulty is above 3, or its description lists many enumerated steps, and it would be clearer as several smaller tasks.
argument-hint: "<taskNum> <numSplits>"
---

- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $1 $2`

Parent task number: $1. Number of children to create: $2.

The command above printed the parent task's full record and the $2 file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $2 ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. Decide $2 reasonable split points in the parent's work — logically separable pieces of what the parent asks for — and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on. The file grouping itself is fixed by the command's output; the only decision here is which piece of work (child description) goes with each group.

For each of the $2 children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $2 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's file group from the command output>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file groups printed above.

If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($1) is still open and was not closed, so the user can decide how to clean up the partial children.

Once all $2 children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas, IN THE SAME ORDER as the file groups printed above:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $1 $2 <childNumbers>
```

This re-validates the child numbers, recomputes the same deterministic file groups from the parent's current `files` array, then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.

Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.
