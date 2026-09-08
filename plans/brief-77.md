# Task 77: Move the task-stats skill body into a script that emits it as a literal brief, mirroring review-plan

## User request

convert 'task-stats' skill body into a script, just like the skill body
  of 'review-plan'.  Keep it simple for now, just copy the task body directly into a
  'const brief = ' object that gets returned.  refactoring the skill body to be like
  'review-plan's skill body with logical code being used to dynamically generate the
  skill body is a separate task.

Seventh and by far the smallest in the family with open tasks #71 (close-tasks), #72 (create-task), #73 (merge-worktree-tasks), #74 (pick-a-task), #75 (tackle-tasks) and #76 (tackle-unblocked-tasks). Same pattern, same constraints, different source file. Do not merge them.

Pattern to copy — skills/review-plan/SKILL.md is 12 lines: frontmatter then a single `!` block (lines 7-11) invoking `node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanBrief.ts"`. The prose lives in scripts/reviewPlanBrief.ts as the exported template literal `reviewerBrief` (lines 39-113); the CLI entry at 132-139 writes it to stdout, guarded by `process.argv[1]?.endsWith("reviewPlanBrief.ts")` so the module stays importable by its test.

Current state — skills/task-stats/SKILL.md is 9 lines: frontmatter 1-4 (name and description only — no argument-hint, no allowed-tools), then a two-line body:
- Line 6 — ``- stats: `` then `node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`, the sole substitution. The script must run it and embed its output.
- Line 8 — the prose: print the block verbatim, compute nothing, read no other file, add no commentary unless the user asks a follow-up. Copied verbatim into the `const brief` template literal.

This skill takes no $ARGUMENTS, so as with #73 and #76 the SKILL.md needs no stdin heredoc — a bare `!` block calling the new script is enough, and reviewPlanBrief.ts's readStdin/fail machinery (lines 115-130) has no analogue to copy. Keep the CLI entry guard so the test can import the brief.

Concrete trap — `${CLAUDE_PLUGIN_ROOT}` appears once, on line 6. Inside a JS template literal `${...}` is interpolation, not literal text, and the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand regardless. reviewPlanBrief.ts solved this at lines 6-7 with `fileURLToPath(new URL("./planReviewRuling.ts", import.meta.url))` and the comment "Absolute, because the reviewer's shell has no CLAUDE_PLUGIN_ROOT to expand". Do the same.

Ordering — checked: no open task declares skills/task-stats/SKILL.md in its files, so this one has no blockers. Alongside #73 it is one of the two immediately workable members of the family. Soft interaction, not a blocker: open task #69 edits scripts/taskStats.ts (the blockedBy `{ taskNum, reason }` shape) but not this SKILL.md, and the brief only embeds that script's output rather than reproducing its logic, so nothing here needs to change when #69 lands.

No logic may be introduced to generate any of the prose; deriving the body dynamically is explicitly a later, separate task.

Hard requirement, stated by the user verbatim: the brief script has to run the dynamic parts itself, then paste their real output into the text it prints, then emit the body with the values already in it.

Do it as a 2-step job:
1. Copy the skill body verbatim into the script file.
2. Replace the inline dynamic injection parts with variables that store the value of those same dynamic injection parts being executed.

Collapsing SKILL.md to a single review-plan-style `!` block removes the only place the current inline `!` injections can live, so they have to move inside the script. A brief script that prints only static text silently drops the skill's live data and ships placeholders.

### scripts/taskStatsBrief.ts

(missing: file not found on disk)

### skills/task-stats/SKILL.md

```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

- stats: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStats.ts"`

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.

```

### tests/taskStatsBrief.test.ts

(missing: file not found on disk)
