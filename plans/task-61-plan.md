# Task 61 Plan: commit-message subagent collects its own diff

## Why

The commit-message subagent currently gets a diff as prompt text that the
*main* agent captured earlier. The main agent's repo view goes stale after
one turn (observed: tasks 58/59/60 staged after the subagent launched, so
the returned message covered neither and mischaracterized what it did see).
This fails silently — the message is plausible-looking but wrong. The fix is
textual: the two doc files that instruct the subagent must tell it to run
the git commands itself, at the moment it starts, and tell the caller to
pass repo paths instead of diff contents. `skills/tackle-tasks/COMMIT_MESSAGES.md`
is the single source of truth for the procedure; `skills/update-tasks/SKILL.md`
should point at it instead of restating (and going stale independently).

## Edits

### 1. `skills/tackle-tasks/COMMIT_MESSAGES.md` line 3

Current text (line 3, exact):

```
Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): give it the staged diff of every affected repo — collected after staging with `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` — and have it generate, per repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
```

Replace it with:

```
Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the path of every repo or submodule in which the caller staged changes — not diff contents — and instruct it to run the collection itself, at the moment it starts: for each supplied repo path, run `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` immediately, treating a repo as affected only if that command produces a nonempty diff, and also run `git -C <repo> diff --staged --raw -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` on each affected repo and treat any line whose old or new file mode is `160000` as a moved submodule pointer — and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
```

Rationale for the specific wording, so it can be checked against "why":
- "pass it the path of every repo or submodule in which the caller staged
  changes — not diff contents" directly implements the brief's "The caller
  should pass repository paths, not diff contents." The caller (not the
  subagent) is responsible for supplying every repo/submodule path it staged
  in — the subagent has no way to discover repos the caller never mentions.
- Running `git -C <repo> diff --staged -- ...` immediately on each supplied
  path, and treating a repo as affected only if that diff is nonempty, is
  the literal command the brief names, now run by the subagent instead of
  the caller, and it doubles as the affected-repo filter: a repo with no
  staged changes in non-excluded paths (or with staged changes only in the
  excluded paths) produces an empty diff and is correctly skipped.
- The added `git -C <repo> diff --staged --raw -- ...` call with a `160000`
  file-mode check is the brief's "detect a moved submodule pointer"
  requirement, made reliable: `--raw` output's old/new mode fields are a
  fixed machine-readable format (`160000` is the gitlink/submodule mode),
  unlike the human-readable `Subproject commit <sha>` line in plain `git
  diff --staged` output, whose presence depends on diff config and is not
  guaranteed to appear verbatim.
- Line 4 of the file ("A parent repo whose only change is a submodule
  pointer counts as an affected repo...") is unchanged: it already states
  the output requirement for that case and needs no rewording.

Do not change lines 1, 2, 4, 5, 6, 7, 8, 9, 10 of this file.

### 2. `skills/update-tasks/SKILL.md` line 27

Current text (line 27, exact):

```
Stage the changes but do not commit. Use a subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors) to generate a short (40 words or less) single-sentence summary of the work done, and show that summary to the user, so the user can use it as a commit message.
```

Replace it with:

```
Stage the changes but do not commit. Follow `skills/tackle-tasks/COMMIT_MESSAGES.md` to generate a commit-message summary for each affected repo, and show the summaries to the user.
```

Rationale: the brief calls this line "the same defect and ... vaguer still —
it says to use a Sonnet 5 subagent to summarise 'the work done' without
saying where the diff comes from at all," and asks to "point it at
COMMIT_MESSAGES.md rather than restating the procedure, so there is one
source of truth." Pointing at the file (rather than re-describing the
subagent/model/diff-collection details) means this line never needs a
second edit if the procedure changes again — only edit 1 above does.

Do not change any other line of this file.

### 3. `tests/commitMessageSubagent.test.ts` — no edit

This file does not exist on disk (confirmed: `Read` on this exact path
returns "File does not exist"). There is nothing to edit. No test file is
created as part of this task: the task has no tests field driving TDD here,
and the change is a wording edit to two instruction documents consumed by an
LLM subagent, not executable logic — there is no runnable assertion to
write against prose.

### Files outside the owned list — confirmed by the brief, not edited

These are named in the brief as depending on the corrected wording but
requiring no edit of their own. They are not in this task's owned-file list,
so they are neither read nor edited here; the brief's own description is
relied on as authoritative:
- `scripts/stage-and-summarize-stop.ts` line 36 — brief states it inlines
  `COMMIT_MESSAGES.md` into a Stop hook, so it picks up the corrected wording
  automatically.
- `skills/tackle-tasks/SKILL.md` line 141 — brief states it does the same
  inlining.
- `skills/close-tasks/SKILL.md` line 22 — brief states it is unaffected: it
  uses a fixed "Closed tasks [...]" message and no subagent.

## Order of operations

1. Edit `skills/tackle-tasks/COMMIT_MESSAGES.md` line 3 (edit 1 above).
2. Edit `skills/update-tasks/SKILL.md` line 27 (edit 2 above).
3. Run verification.

No ordering dependency exists between the two edits; either may be done
first. Doing COMMIT_MESSAGES.md first only matters for readability while
implementing (the file the other one now points to).

## Verification

Run from repo root `/Users/matkatmusicllc/Programming/taskTools`:

1. `git diff --stat -- skills/tackle-tasks/COMMIT_MESSAGES.md skills/update-tasks/SKILL.md`
   Expected: both file names listed, followed by the aggregate summary line
   `2 files changed, 2 insertions(+), 2 deletions(-)`
   (a single-line replacement in each file, no line-count change).

2. `rg -n "give it the staged diff" skills/tackle-tasks/COMMIT_MESSAGES.md`
   Expected: no output (old wording removed).

3. `rg -n "not diff contents" skills/tackle-tasks/COMMIT_MESSAGES.md`
   Expected: one match, on line 3.

4. `rg -n -- "--raw" skills/tackle-tasks/COMMIT_MESSAGES.md`
   Expected: one match, on line 3.

5. `rg -n "Follow \`skills/tackle-tasks/COMMIT_MESSAGES.md\`" skills/update-tasks/SKILL.md`
   Expected: one match, on line 27.

6. `rg -n "Use a subagent running" skills/update-tasks/SKILL.md`
   Expected: no output (old restated-procedure wording removed).

7. `git status --short`
   Expected: only `skills/tackle-tasks/COMMIT_MESSAGES.md` and
   `skills/update-tasks/SKILL.md` show as modified (` M`) among files
   touched by this task — no other file changed.
