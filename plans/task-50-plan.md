# Task 50 plan: not relevant

## Verdict

Task 50 is **not relevant** to the current codebase. No edit is planned.

## Evidence

1. **The file the task targets does not exist.** `ls skills/tackle-tasks/`
   shows: `.gitignore`, `COMMIT_MESSAGES.md`, `SKILL.md`,
   `implement.workflow.js`, `merge.workflow.js`, `plan.workflow.js`,
   `test.workflow.js`, `verify.workflow.js`. There is no
   `tackle-tasks.workflow.js`. The brief itself already notes this under the
   file's heading: `(missing: file not found on disk)`.

2. **The monolith was already split before task 50 was written.**
   `git log --oneline --all -- skills/tackle-tasks/tackle-tasks.workflow.js`
   shows the file's last commit is `ee0bd6b`, whose message is "Splits the
   tackle-tasks skill's monolithic workflow script into five self-contained
   per-phase scripts (plan, verify, ...)". That commit is what produced the
   five `*.workflow.js` files listed above and retired
   `tackle-tasks.workflow.js` for good. Task 50 asks to "rewire
   skills/tackle-tasks/tackle-tasks.workflow.js" and "replace MERGE_SCHEMA"
   inside it — a file and a constant that no longer exist anywhere in the
   skill.

3. **The behavior task 50 asks for already exists, built through the
   split files instead.** The currently-read `skills/tackle-tasks/SKILL.md`
   (lines 41–125) already runs plan → verify → implement → test as
   independent phases, then **Step 5 — approval**, which says: "Present
   `needsClarification`, `rejected`, `partial`, `blocked` and `tests` to the
   user... **Do not launch the merge workflow until the user approves the
   work.**" — before **Step 6 — merge**, which starts "Only after the user
   approved in step 5." The approval gate already runs before the
   merge/finalize/close-tasks work, exactly what task 50 asks for ("the
   whole-run approval gate runs before finalization").

4. **Task 31's approval-gate modules are already wired into the pipeline,
   just through different files than task 50 names.** `git log --oneline
   --all` shows `059d952`/`ac3665f` "task 31: add whole-run approval gate
   with state digest and drift invalidation", and later `ebbc081` "task 53:
   mint run approval and publication targets in mergeTaskWorktrees, threaded
   through prepareTasks and merge.workflow.js". That is: the task 31 modules
   were threaded through `prepareTasks.ts` and `merge.workflow.js` (task 53),
   not through a `tackle-tasks.workflow.js` MERGE_SCHEMA rewrite, because by
   the time task 53 ran, the monolith (task 50's edit target) was already
   gone.

## Why this rules out "planned"

Task 50's two owned files are `skills/tackle-tasks/tackle-tasks.workflow.js`
and `skills/tackle-tasks/SKILL.md`.

- The first file has no on-disk existence to edit — there is nothing to
  "rewire," no `MERGE_SCHEMA` constant to replace, and inventing a new file
  under that name would silently reintroduce the monolith the codebase
  deliberately split apart in `ee0bd6b`, contradicting the current
  five-script structure the rest of `SKILL.md` (lines 41–127) already
  documents and depends on.
- The second file, `SKILL.md`, already implements the exact ordering task 50
  asks for — approval (step 5) before merge/finalize (step 6) — via the
  task 31/53 work. There is no discrepancy between what `SKILL.md` currently
  says and what task 50 wants it to say; nothing in it needs to change to
  satisfy the brief's stated goal.

Because the task's premise (a monolithic `tackle-tasks.workflow.js` still
carrying a `MERGE_SCHEMA` and returning "immediate merge results") no longer
matches the codebase, and the outcome it wants ("orchestrator presents the
gate before anything is finalized or archived") is already true of the live
`SKILL.md`, there is no edit within the owned files that would change
anything. This task should be closed as superseded by the work already done
in the task 31 → task 41/split → task 53 chain, not implemented.
