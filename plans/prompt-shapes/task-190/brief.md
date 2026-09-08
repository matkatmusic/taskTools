# Task 190: Add a /mermaid skill that diagrams a codebase into a .mmd file

## Goal

**This task is considered done when all of these are true:**

- A /mermaid skill exists at skills/mermaid/SKILL.md and appears in the skill list.
- Running /mermaid against a codebase writes a .mmd file the user can name and open.
- The written .mmd follows the diagrams/tackle-tasks grammar: flowchart TB, boxes declared inside subgraphs as BOX_ID["label"], edges written as A -- "label" --> B, decision boxes branch with two edges labeled YES and NO (never separate _YES/_NO boxes), a classDef/class block assigns every box a role, and cross-section targets are grouped in a "next diagram" subgraph joined by an invisible ~~~ link.
- The skill contains an explicit written checklist of those diagram rules, and the skill follows that checklist when it draws.

## Not in scope

- NOT in scope: changing any existing diagram in diagrams/tackle-tasks/, and changing scripts/generateSteps.ts. The skill only reads generateSteps.ts as the reference parser whose grammar its output must match; the skill's own output documents an arbitrary codebase and need not itself be runnable by generateSteps.ts.

## problemSolvedByTask

Understanding an unfamiliar codebase's control flow means reading files by hand — no automated way to get a flowchart.

## User request

make a '/mermaid' skill that searches a codebase and builds a .mmd mermaid diagram.  it should follow the same mermaid diagram rules that I used for the diagrams in taskTools-86 (Yes/No boxes at decision points, output boxes -> what gets outputted, etc)

Add a new /mermaid skill (skills/mermaid/SKILL.md, following the existing skill format seen in skills/view-task/SKILL.md and skills/create-task/SKILL.md) that searches a target codebase and emits a .mmd mermaid flowchart. It must codify the diagramming grammar already used in diagrams/tackle-tasks/*.mmd and parsed by scripts/generateSteps.ts (see getEdgesInDiagram and getPromptBoxesInDiagram, roughly lines 60-120, and the `returns_a_prompt` class-role check at line 111 (`getPromptBoxesInDiagram`)): `flowchart TB`, boxes declared inside a named `subgraph ... end` block as `BOX_ID["label"]` (a decision box is a plain rectangular box whose id ends in `_Q`, not a diamond node), edges written `A -- "label" --> B` or `A --> B`, decision boxes branching with two edges whose labels are literally `YES` and `NO` (extra detail can follow on a `<br/>` line) rather than separate `_YES`/`_NO` boxes, a `classDef`/`class` block at the end assigning every box exactly one role among `script`, `returns_a_prompt`, `next_diagram`, `output`, and `fail`, and any box the diagram references but does not itself resolve grouped into a second `subgraph ... ["next diagram"]` block joined to the main subgraph by an invisible `~~~` link. Reference examples: diagrams/tackle-tasks/pipeline-planTheTask.mmd, diagrams/tackle-tasks/pipeline-whatIsReviewVerdict.mmd, and diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd. No existing skill in skills/ produces diagrams; this is a new skill directory, not an edit to an existing one. The skill must also carry an explicit written checklist of these diagram rules that it follows while it draws. The /mermaid skill documents codebases generally, not just taskTools pipelines, so its output does not need to be runnable by generateSteps.ts (which is hardcoded to the tackle-tasks box-ownership map) — it only needs to follow the same grammar.

## Files

### skills/mermaid/SKILL.md

(missing: file not found on disk)
