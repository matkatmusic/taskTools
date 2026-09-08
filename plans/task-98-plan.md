# Plan: Task 98 — close-tasks drains the legacy `files` key by renaming it to `modifiableFiles`

## Scope

Owned file: `skills/close-tasks/SKILL.md`. This file's full current content (12 lines) was read in full:

```
---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasksBrief.ts" <<'CLOSETASKSEOF'
$ARGUMENTS
CLOSETASKSEOF
```
```

The file is a slash-command definition: front matter, then one bash tool-call block that runs `scripts/closeTasksBrief.ts` and feeds it `$ARGUMENTS`. It contains no other prose today. `scripts/closeTasksBrief.ts` is out of scope for this task (not in the owned-files list; siblings own the reader/writer scripts) and is not edited.

## Edit

**File:** `skills/close-tasks/SKILL.md`

**Location:** end of file, after the closing ` ``` ` fence on line 12. Append a new markdown section (no blank trailing content exists after line 12 to preserve).

**Current text (lines 9–12, exact):**
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasksBrief.ts" <<'CLOSETASKSEOF'
$ARGUMENTS
CLOSETASKSEOF
```
```

**Becomes (lines 9–12 unchanged, then new content appended):**
```
node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasksBrief.ts" <<'CLOSETASKSEOF'
$ARGUMENTS
CLOSETASKSEOF
```

## Migration: `files` → `modifiableFiles`

On every close-tasks invocation, unconditionally rename any remaining `files` key to `modifiableFiles` on every task still holding one in the project's tasks.json — not just the tasks being closed this run, and regardless of whether any task actually closes this run. This is bookkeeping-subagent work (see the related-memory note in the brief): if the run closes zero tasks and would otherwise not write tasks.json, still write it when a legacy `files` key is present so the migration happens; do not skip the write just because there is nothing to archive.

Rules, applied per task:
- If a task has `files` and no `modifiableFiles`: rename `files` to `modifiableFiles`. Keep its list exactly as-is. Touch no other key on that task.
- If a task already has `modifiableFiles` and no `files`: leave it untouched.
- If a task has both `files` and `modifiableFiles`: keep `modifiableFiles`, delete `files`. Do not merge the two lists — `modifiableFiles`'s existing value wins as-is.
- If a task has neither key: leave it untouched. Do not add a `readOnlyFiles` key or a `modifiableFiles` key to it. An absent `readOnlyFiles` is meaningful and must stay absent; readers resolve it to `['*']` themselves.
- Never reorder tasks and never renumber a task's `taskNum` (or any other field) while doing this rename.

This is a rename-only pass performed by the bookkeeping subagent. When the run also archives closed tasks, the rename and the archive write happen in the same tasks.json write. When the run closes nothing, the rename still happens in its own write.
```

**Implementer's edit tool call:** `Edit` on `skills/close-tasks/SKILL.md` with:
- `old_string`: the exact 4 lines `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasksBrief.ts" <<'CLOSETASKSEOF'\n$ARGUMENTS\nCLOSETASKSEOF\n\`\`\`` (i.e. lines 9–12 verbatim, ending in the bare closing fence with no trailing newline content after it)
- `new_string`: the same 4 lines, followed by a blank line, then the `## Migration: ...` section shown above verbatim (heading through the final paragraph ending "When the run closes nothing, the rename still happens in its own write.")

No other line in the file changes. Front matter (lines 1–6, including `allowed-tools`) is untouched — the migration is described as prose guidance for the existing bookkeeping subagent step, not a new bash invocation, so no new tool needs to be allow-listed.

## Files accounted for

- `skills/close-tasks/SKILL.md` — one edit, described above in full.

No other owned files exist for this task (the brief's `Files:` list names only this one path, matching the task-scoping instruction).

## Verification

1. `git diff skills/close-tasks/SKILL.md` — expected: the only change is the appended `## Migration: files → modifiableFiles` section after the existing closing fence; lines 1–12 are byte-identical to before.
2. `grep -c "modifiableFiles" skills/close-tasks/SKILL.md` — expected: count ≥ 1 (the new section mentions it).
3. `grep -n "readOnlyFiles" skills/close-tasks/SKILL.md` — expected: one match, in the sentence stating an absent `readOnlyFiles` must stay absent (confirms no instruction to invent the key).
4. Run the brief's `Tests:` fixture for real: build a `tasks.json` holding one task declaring only `files: ["a.ts"]`, one task declaring only `modifiableFiles: ["b.ts"]`, and one task declaring both `files: ["c.ts"]` and `modifiableFiles: ["d.ts"]`. Invoke close-tasks against that fixture (closing zero tasks, so the migration write is the only write this run makes) and inspect the resulting `tasks.json`:
   - The `files`-only task now has `modifiableFiles: ["a.ts"]` and no `files` key; list unchanged, no other key touched. Matches expected outcome "legacy task's key is renamed with its list unchanged."
   - The `modifiableFiles`-only task is byte-identical to its input. Matches expected outcome "already-migrated task is untouched."
   - The both-keys task now has `modifiableFiles: ["d.ts"]` only — `files` removed, no merge into `["c.ts","d.ts"]` or similar. Matches expected outcome "both-keys task keeps modifiableFiles and loses files with no list merging."
   - None of the three fixture tasks gains a `readOnlyFiles` key, and task order and `taskNum` values are unchanged from the input. Matches the remaining two expected outcomes.

Checks 1–3 are static inspection of the edited SKILL.md text. Check 4 is a live run of close-tasks against the fixture, confirming the new instructions actually produce the required behavior and not just readable prose.
