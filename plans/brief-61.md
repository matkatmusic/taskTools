# Task 61: Have the commit-message subagent collect the staged diff itself instead of receiving it from the main agent

## User request

make the commit-message subagent always get the latest git changes programmatically, instead of from the main agent, because the main agent's repo view goes stale after 1 conversation turn.

The commit-message subagent must run the git commands itself, at the moment it starts, rather than being handed a diff the main agent captured earlier. The main agent's view of the repository goes stale as soon as anything else is staged, so a diff passed in as prompt text describes a snapshot that may no longer match HEAD's index.

Observed in a real run of this pipeline: the commit-message subagent was launched, and tasks 58, 59 and 60 were staged afterwards. The returned message described neither of them and mischaracterised the code change it did see. Nothing errored — the message was simply wrong, which is the dangerous failure mode, because a wrong-but-plausible commit message gets used.

The wording that causes this is in skills/tackle-tasks/COMMIT_MESSAGES.md: "give it the staged diff of every affected repo — collected after staging with git -C <repo> diff --staged ...". "Give it" puts the collection in the caller's hands and makes the diff prompt text. Rewrite so the subagent is instructed to run `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` itself, along with whatever it needs to enumerate the affected repos and detect a moved submodule pointer. The caller should pass repository paths, not diff contents.

skills/update-tasks/SKILL.md line 27 has the same defect and is vaguer still — it says to use a Sonnet 5 subagent to summarise "the work done" without saying where the diff comes from at all. Point it at COMMIT_MESSAGES.md rather than restating the procedure, so there is one source of truth.

Note that scripts/stage-and-summarize-stop.ts (line 36) inlines COMMIT_MESSAGES.md into a Stop hook, and skills/tackle-tasks/SKILL.md (line 141) does the same, so both pick up the corrected wording automatically with no edit of their own. skills/close-tasks/SKILL.md line 22 is unaffected: it uses a fixed "Closed tasks [...]" message and no subagent.

### skills/tackle-tasks/COMMIT_MESSAGES.md

```
If you made any changes to the codebase — which may span multiple git repos or submodules — stage the changes in each affected repo, but do not commit in any of them. Then generate one commit message per repo:

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): give it the staged diff of every affected repo — collected after staging with `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` — and have it generate, per repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```

```

### skills/update-tasks/SKILL.md

```
---
name: update-tasks
description: scan plans/ implementation notes and handoffs for open items/questions, add them to tasks.json, then archive the notes into plans/archived/
allowed-tools: Bash(git add *)
---

First, invoke `/ponytail:ponytail ultra`.

Then:

1. Files to process: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts" --list`

2. Extracted open-work sections (every `### Open questions` section from implementation notes, the `## What Remains` section from handoffs; each under a `=== <file> ===` banner): 
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts"`


   Apply judgment to the extracted text above: skip items the section itself marks as resolved (e.g. "None blocking"), and skip empty sections.

3. **De-duplicate.** Before adding, check both `tasks.json` and `completedTasks.json` (titles and descriptions) for an existing task covering the same item. If an open item belongs to an existing open task, extend that task's `description` (and add the source file to its `handoffFilePaths`) instead of creating a duplicate.
Titles: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts"`

4. **Create each new task via the `create-task` skill** — one Skill-tool invocation per task, sequentially (each invocation injects the then-current next taskNumber). Pass as args: a short title, the open item in the source file's own wording (with enough context to act on it later — file paths, item numbers), and the source file's **archived** path (e.g. `plans/archived/implementation-notes-item66-fork-style-port.md`) to record as `handoffFilePaths`. The wording is already refined here — create-task should not need AskUserQuestion. If the Skill tool is unavailable, append directly to `tasks.json` in the same format instead (`taskNumber` = run `node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"` before each append, `title`, `description`, `handoffFilePaths`; omit completion-related fields).

5. **Archive the processed files**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/archiveProcessed.ts" <the step-1 file list>`. It moves each given file into `plans/archived/` (a file that yielded no new tasks is still retired by processing it) and leaves any file in place whose name already exists in `plans/archived/`, printing `COLLISION` for it — report those collisions.

Finally, report a short table: each archived file → the task numbers created from it (or "none / duplicate of task N"). 
Stage the changes but do not commit. Use a subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors) to generate a short (40 words or less) single-sentence summary of the work done, and show that summary to the user, so the user can use it as a commit message.

```

### tests/commitMessageSubagent.test.ts

(missing: file not found on disk)
