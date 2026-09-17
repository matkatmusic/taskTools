---
name: backwards
description: interview the user to build an ordered step list from the current project state to a goal, working backwards from the goal, and write it to specs/<goal-name>.md
argument-hint: "<goal>"
---

Standing rule for every step below: the user's answers are rough and out of order. Your job is to turn them into concrete, checkable steps. Use `/grill-me` to pin down every vague answer.

1. Ask the user what they want to accomplish, unless `$ARGUMENTS` already says it. Write the goal as one sentence that describes the finished state, e.g. "Mermaid skill no longer exists here and functions correctly in the destination project."  This item becomes the last line in the backwards list.

2. Ask the user what steps they think are needed to get there. Accept them in any order. Do not ask the user to order them.

3. Read the repository (source code and git history, not .md docs) to establish the current project state. Write it as one sentence. This is the first line of the list.

4. Build the list backwards. Start at the goal and ask: "What must be true immediately before this?" Place the answer above it. Repeat from that new step until the step above is the current project state.
   - Slot each step the user gave in step 2 where it belongs.
   - When two neighboring steps do not connect, a step is missing. Read the repository to find it. If the repository cannot answer, ask the user what they think the prior step is, then grill the answer until it is concrete.
   - Each step is one line: either an action ("Copy mermaid skill and scripts and tests to the destination code base") or a checkable milestone ("Full test suite passes here with no failing tests").
   - Each step must be small enough to become one task via `/create-task`.

5. Show the user the full list, top (current state) to bottom (goal). Walk it forwards once: each step must be possible given only the steps above it. Fix every gap the user or the walk finds.

6. Write the list to `specs/<goal-name>.md` in the target repo, where `<goal-name>` is a short kebab-case name for the goal:

   ```markdown
   # <goal>

   1. Start: <current project state>
   2. <step>
   3. <step>
   ...
   N. Goal: <goal>
   ```

Do not create tasks. The user turns each line into a task with `/create-task`, then runs `/tackle-tasks`.
