---
name: backwards
description: interview the user to build an ordered step list from the current project state to a goal, working backwards from the goal, and write it to specs/<goal-name>.md
argument-hint: "<goal>"
---

Standing rule for every step below: the user's answers are rough and out of order. Your job is to turn them into concrete, checkable steps. Use `/grilling` to pin down every vague answer. Ask every question through the `AskUserQuestion` tool.

## The file

1. Create `specs/<goal-name>.md` in the target repo as soon as **The interview preamble** step 1 produces the goal, where `<goal-name>` is a short kebab-case name for the goal. The file holds only the goal at this point. 
2. Give the user the absolute path to the file so they can read it while the list is built. 
3. Rewrite the file after every change to the list, so the file on disk always matches the list. The finished file has this shape:

   ```markdown
   # <goal>

   1. Start: <current project state>
   2. <step>
   3. <step>
   ...
   N. Goal: <goal>
   ```

## Each Step needs 'WHAT', 'WHY', and Optionally 'HOW'
Each step in the backwards list should clearly state:
- **WHAT**: The goal of this step.  This is the title of the step.
- **WHY**: Why this particular goal is necessary at this specific step in the context of reaching the overall goal.
- **HOW** (optional): How to accomplish this step, if it is not immediately obvious.  references to code or documentation may be included in the HOW section, but the step should remain concise.  The step is not meant to replace a full plan, but simply offer a hint or guidance for how to accomplish the WHAT. 

## The interview preamble

1. Ask the user what they want to accomplish, unless `$ARGUMENTS` already says it.  This item becomes the last line in `specs/<goal-name>.md`. Write the goal as one sentence that describes the finished state, e.g. "Mermaid skill no longer exists here and functions correctly in the destination project." 

2. Ask the user what steps they think are needed to get there. Accept them in any order. Do not ask the user to order them. Your job is to order them, and slot them correctly in the backwards list, as the list is filled in.

3. Read the repository (source code and git history, not .md docs) to establish the current project state. Write it as one sentence. This is the first line of the list.

## The backwards list building loop

1. Build the list backwards, in a loop with the user. Start at the goal item and ask: "What must be true immediately before this?" Place the answer on the line above the goal item. Slot each step the user gave in preamble step 2 where it belongs. Then repeat this loop:
   a. Find a gap: two neighboring steps that do not connect. Tell the user: "I found a gap between <step X> and <step Y> that needs to be filled."
   b. Research the gap: read the repository to learn what the missing step or steps could be.
   c. Ask the user questions, based on the research results, to fill the gap. Grill each answer until the steps to fill the gap are provided and concrete enough to be added to the list.
   d. Write the new step or steps into the list.

   The loop ends only when the list connects from the current project state to the goal with no gaps, and the user says the list is filled in to their satisfaction. Ask the user; do not decide this yourself.

   Rules for every step in the list:
   - Each step is one line: either an action ("Copy mermaid skill and scripts and tests to the destination code base") or a checkable milestone ("Full test suite passes here with no failing tests").
   - Each step must be small enough to become one task via `/create-task`.

2.  Walk the full list forwards once: each step must be possible given only the steps above it. Fix every gap the user or the walk finds. Use `/grilling` to clarify any vague steps or gaps you find.

When completed, ask the user if they would like each item turned into a task with `/create-task`.
