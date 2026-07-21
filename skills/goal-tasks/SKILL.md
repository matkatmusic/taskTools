---
name: goal-tasks
description: interview the user to define the project goal, produce a testable spec at specs/SPEC.md, and create ordered tasks that achieve it
argument-hint: "<project goal>"
---

Standing rule for every step below: if the user is vague or unsure, use AskUserQuestion to fill specific gaps, or `/grill-me` for open-ended direction-setting.

1. Interview the user to find the real goal of this project.

2. Draft the spec at `specs/SPEC.md` in the target repo, following the template at `${CLAUDE_PLUGIN_ROOT}/skills/goal-tasks/templates/SPEC.md`. Spec items must be concrete and verifiable via tests. Record decisions the user has explicitly verified under Key Decisions. Leave each item's `Tasks:` line empty for now.

3. Confirm the goal, spec items, and key decisions with the user. Do not create any tasks until the user agrees.

4. Use `/create-task` to create granular tasks that, when all are completed, achieve the goal. Encode order with `blockedBy` so progress toward the goal is measurable. Each task should be completable in under 20 minutes and at most ~200 lines of code — split larger spec items into multiple tasks, merge trivial ones.

5. Backfill the created task numbers into each spec item's `Tasks:` line.

6. Stage `specs/SPEC.md` and `tasks.json`. Do not commit.

`specs/SPEC.md` is a living document: `/close-tasks` marks items done as tasks complete, and `/create-task` appends new task numbers to the relevant item.
