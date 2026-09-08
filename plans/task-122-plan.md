# Task 122 Plan: Dummy smoke task — create docs/dyn-inj-smoke.md

## Why
This is a throwaway payload task whose sole purpose is to be driven end to
end through `/tackle-tasks` to confirm that the dyn-Inj (dynamically
injected) brief-script skills (commit 09c412b / 85232c8, which moved
close-tasks, create-task, merge-worktree-tasks, tackle-unblocked-tasks,
update-task-files, and tackle-tasks SKILL.md bodies into
`scripts/<name>Brief.ts`) still drive a full plan-implement-verify-merge
cycle. The file content itself carries no product meaning — it only needs
to exist so the run has something concrete to create and later delete.

## Owned files

### docs/dyn-inj-smoke.md
Confirmed via Read: this path does not exist in the repo. This is expected
— the file does not exist yet because creating it is the task's entire
deliverable, not a pre-existing file being edited.

**Action: create this file.**

Full file contents (exactly one line, no trailing content beyond the
newline that a normal editor/write adds):

```
dyn-Inj smoke test OK
```

No other content, no heading, no trailing blank line beyond the single
newline terminating that line.

## Steps

1. Create `/Users/matkatmusicllc/Programming/taskTools/docs/dyn-inj-smoke.md`
   with exactly this content:
   ```
   dyn-Inj smoke test OK
   ```

That is the only edit this task requires. No other file in the repo is
touched by this task.

## Verification

Run:
```
cat /Users/matkatmusicllc/Programming/taskTools/docs/dyn-inj-smoke.md
```
Expected output: exactly one line reading `dyn-Inj smoke test OK`.

Run:
```
wc -l /Users/matkatmusicllc/Programming/taskTools/docs/dyn-inj-smoke.md
```
Expected output: `1 /Users/matkatmusicllc/Programming/taskTools/docs/dyn-inj-smoke.md`
(confirms exactly one newline-terminated line, no extra content).

## Post-run cleanup (not part of this task's implementation step)

Per the brief: once the smoke run through `/tackle-tasks` has been observed
to succeed, `docs/dyn-inj-smoke.md` should be deleted and task 122 closed.
That cleanup is a separate follow-up action taken after observing the run,
not part of the plan-implement step this plan covers.
