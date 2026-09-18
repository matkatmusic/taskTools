# The pipeline diagrams use the mermaid-viewer format, the generator parses them, and a new block can be spliced into the pipeline by an edit to the diagram alone.

Reference for the target diagram format: `plans/preamble-revised.mmd`.
Rule: every step has three parts on three lines. WHAT: one sentence that says what the step does. WHY: the reason. HOW: what gets built.
Rule: no block name is typed into any source file. Only the diagram and its `diagram-steps.json` hold block names.
Scope: the existing pipeline in `diagrams/tackle-tasks/` migrates first, one diagram at a time, starting with the preamble. Fast mode is a later goal and is not touched here.

1. Start: `scripts/tackle-tasks/generateSteps.ts` parses only plain-ID diagrams; every live diagram in `diagrams/tackle-tasks/` uses plain IDs and no `file:` line; the script for a block is always `scripts/tackle-tasks/<owner folder>/<BOX_ID>.ts`; the start block and the lock block are named by literals in `runStepHook.ts`, `generateWorkflow.ts`, and `resetTask.ts`.

2. WHAT: Make the generator read the three new node kinds, `B_`, `Q_`, and `Q_CHOICE_`, next to the plain-ID style it reads today.
   WHY: this is the only node style the mermaid-viewer tool can draw, and the two styles must live side by side while the diagrams migrate one at a time.
   HOW: The block name in `diagram-steps.json` is the name as drawn, prefix included (e.g. `B_LOCK_SOURCE_REPO`). A `Q_CHOICE_` node is not a block: it gets no script and no entry. The block a choice node points at goes into its parent decision's `next` list, so a decision script keeps returning the target block name and the hook's routing code needs no change. Plain-ID diagrams still parse as before.

3. WHAT: Make the generator read a `block:<diagram>.mmd::<BLOCK>` line in a node's text.
   WHY: the viewer needs one node per diagram to show where the flow continues, and the hook needs no new code to follow it.
   HOW: Such a node is a signpost to a block in another diagram. Example: `B_REPORT_ONLY_EXIT["REPORT_ONLY_EXIT<br/>block:pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT"]`. The signpost gets no script and no entry. Any block with an arrow to the signpost gets `pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT` in its `next` list, as if the arrow went straight to that block. This is the same `<diagram>.mmd::<BLOCK>` form that `next` already uses today for a hop into another diagram, and `getStepKey` in the hook already reads it, so the entry format does not change.

4. WHAT: Make the generator read the `file:` line in a block's text and write that path into the block's entry.
   WHY: `diagram-steps.json`, not a hard-coded folder map, says which script a block runs, and the generator populates `diagram-steps.json` from the `file:` key in the block's text value.
   HOW: Generator reads a `file:<path>` label line from a diagram's block text and uses that path (relative to `scripts/`) as the block's script and writes it to the block entry in `diagram-steps.json`; the template path is the same path with `.template.json`.

5. WHAT: Make the generator fill in a missing `file:` line in a diagram block and create the script stub.
   WHY: a user adds a block by drawing it; the generator does the rest, and a forgotten block fails loudly.
   HOW: A `B_` or `Q_` node with no `file:` line gets `file:<diagramName>/<blockNameAsCamelCase>.ts` written into its diagram text. If that file is not on disk, the generator writes a stub that throws "block <name> in <diagram> is not implemented". `Q_CHOICE_` nodes are not modified.

6. WHAT: Make the generator sync `diagram-steps.json` back into the diagram.
   WHY: the user re-points a block at another script by editing `diagram-steps.json`; the `.mmd` must never drift from `diagram-steps.json`.
   HOW: When a `diagram-steps.json` entry's `script` differs from the diagram's `file:` line, `diagram-steps.json` wins and the `file:` line in the diagram's block is rewritten.

7. WHAT: Make the generator record the start block in `diagram-steps.json`, and make the hook and the workflow read it from there.
   WHY: the diagram decides where a run begins; `diagram-steps.json` mirrors the diagram.
   HOW: Generator writes `"start": "<diagram>.mmd::<BLOCK>"`, taken from the one node in the folder that no arrow points at. `generateWorkflow.ts` and `runStepHook.ts` read the start block from that key. The `START_STEP` literals in both files are commented out.

8. WHAT: Make the generator read `takesSourceLock:true` and sync it with `diagram-steps.json`, and make the code find the lock block by that flag.
   WHY: the code must know which block takes the source-repo lock, so it can list every block that runs while the lock is held, and that fact belongs in the diagram.
   HOW: Generator reads a `takesSourceLock:true` label line and writes `takesSourceLock: true` on that block's entry. The same sync as step 6 applies: if the user moves the flag in `diagram-steps.json`, the generator moves the label line in the diagram. `runStepHook.ts` and `resetTask.ts` find the lock block by this flag. The `LOCK_SOURCE_REPO` literals in both files are commented out.

9. WHAT: Drop the `mutating` flag.
   WHY: nothing in the pipeline reads the flag. The "never run a state-changing block twice" job it was named for is done today by the per-step receipt in `shared/taskRunState.ts`.
   HOW: The carry-over code in `generateSteps.ts` (the code that copies `mutating` from the old `diagram-steps.json` into the new one) is commented out, and the test skip in `tests/stepTemplates.test.ts` that reads `entry.mutating` is commented out. The 24 flags stop being written on the next generation.

10. WHAT: Make each diagram folder own one `diagram-steps.json`, and let the skill argument pick the folder.
   WHY: a custom diagram set runs with no code change.
   HOW: `tackle-tasks [N] [fast | <diagram folder>]` picks the folder; the hook and the workflow load that folder's `diagram-steps.json`.

11. WHAT: Replace the preamble diagram with the new-format one.
   WHY: this is the first diagram to migrate, and it also carries the new catch-up flow. The stubs mark the scripts still to be written in a later goal.
   HOW: `plans/preamble-revised.mmd` becomes `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd`. Every node in the plain-ID diagrams that points at a preamble block is renamed to the preamble's new block name (the generator's dead-link guard lists each one). The generator is run: existing blocks keep their scripts through their `file:` lines; the new catch-up blocks (`B_LOCK_STAGING_FOR_CATCH_UP`, `Q_CATCH_UP_STAGING`, and the others with no script) get throwing stubs.

12. WHAT: Comment out the default-pipeline override tables.
   WHY: the diagram must be the only source of the route.
   HOW: `NEXT_BLOCK_OVERRIDES` and `TRANSLATOR_OVERRIDES` at `generateSteps.ts:16-22` are commented out. The route they carried (PREAMBLE_STATUS_CHECK to IS_TASK_BLOCKED_Q) is already drawn in the new preamble diagram. `FAST_NEXT_BLOCK_OVERRIDES` stays until fast mode migrates.

13. Full suite passes via `npm run test:baseline`.

14. WHAT: Prove the splice.
   WHY: this is the goal, shown once by hand.
   HOW: One new block is added to the preamble diagram by drawing it only; the generator is run; the `file:` line, the stub, and the entry appear; the pipeline starts a task and reaches the block, and the block throws "not implemented".

15. Goal: The pipeline diagrams use the mermaid-viewer format, the generator parses them, and a new block can be spliced into the pipeline by an edit to the diagram alone.
