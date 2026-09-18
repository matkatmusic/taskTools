# PLAN 1 — `generateSteps.ts` reads the `B_` / `Q_` / `Q_CHOICE_` style

Needs: nothing. Order of work: Plan 2, then Plan 1, then Plan 3.

## Rules for every plan
- Test first: write the failing test, run ONLY that test file with `node --test <file>` to see it fail for the stated reason, then write the code.
- The FULL suite runs only through `npm run test:baseline`. Edit agents never run the full suite. One later agent owns that run.
- Never commit. Never delete retired code; comment it out.
- No helper extraction, no refactor. Two near-identical blocks of code stay two blocks.
- One condition for each `if`; nest, do not chain with `&&`.
- A comment is one line, under 20 words. Never two stacked `//` lines.

## Context

The viewer at `~/Programming/relationship-mermaid` accepts only ids that start with `B_` (block, `[]`), `Q_` (decision, `{}`), or `Q_CHOICE_` (one answer of a decision, `[]`) (`editor-graph.ts:100-122`). The `mermaid` skill writes the same forms. `scripts/tackle-tasks/generateSteps.ts` cannot read that style today: it throws on the 16 preamble scripts (orphan guard, `:311`), makes a stub for each choice box, and drops the `mutating` flag of 11 blocks with no error.

This plan changes the generator so it reads the old style AND the new style, and moves ONLY the preamble diagram to the new style, with its CURRENT flow. Pipeline behavior does not change. The source for the converted diagram is `plans/preamble-current.mmd` (already checked by the viewer's `editorGraph()`).

User decisions:
- The block name in `steps.json` is the FULL id (`B_CREATE_WORKTREE`, `Q_IS_TASK_BLOCKED_Q`).
- A `Q_CHOICE_` box is logic, not action: no script, no entry. `Q_X --> Q_CHOICE_X_Y --> B_T` adds `B_T` to the `next` list of `Q_X`.
- A label line `file:<path>` names the stub script. The path is relative to `stepsRoot` (`scripts/tackle-tasks`). It ends at the next `<br/>` or the closing quote. The template path is the same path with `.ts` replaced by `.template.json`.
- No `file:` line: no stub is made. If the old `steps.json` has an entry for the block, its `script` and `template` paths are kept. If it has no entry, the generator throws: `<diagram>::<box> has no file: line and no earlier steps.json entry`.
- A label line `block:<diagram>::<BOX>` names the real target in an old-style diagram. That node gets no entry and no stub.
- The 16 old preamble scripts keep their file names and folder.

## Rules the generator follows (no style flag for each file; each rule reads the id or the label)

| Rule | When | Effect |
|---|---|---|
| Choice fold | id starts with `Q_CHOICE_` | The box leaves `boxes` and `next`. Each box that pointed at it points at the choice's targets, in the choice's position, with no duplicate. |
| `file:` | a label line starts with `file:` | Script path = that text under `stepsRoot`. Stub is written when absent and stubs are allowed. |
| `block:` | a label line starts with `block:` | No entry, no stub. Arrows into the node are written into `next` as the `block:` value. |
| Prefixed, no `file:` | id matches `/^(B|Q)_/`, no `file:`, no `block:` | Keep `script` + `template` of the old entry with the same `<diagram>::<box>` key. No old entry: throw. Never a stub. |
| Any other id | old style | No change: `<ownerFolder>/<box>.ts`. |

Known limit, marked in code with one `// ponytail:` comment: a choice box that points at a second choice box is not folded.

New shapes in `generateSteps.ts`. Add these types and constants after the closing `};` of the whole `BLOCKS_BY_OWNER_FOLDER` object (`:70` today), right before `BLOCK_OWNER_FOLDER` (`:71`), so lines `:1-70` do not move:

```ts
export type DiagramLabelKeys = { scriptFileByBox: Record<string, string>; blockTargetByBox: Record<string, string> };
type ParsedDiagram = DiagramEdges & { promptBoxes: string[] } & DiagramLabelKeys;
type BlockFiles = { scriptPath: string; templatePath: string; mayWriteStub: boolean };
const CHOICE_BOX_PREFIX = "Q_CHOICE_";
const PREFIXED_BLOCK_ID = /^(B|Q)_/;
```

Label regex, run on each statement after the `%%` comment is cut: `/([A-Za-z0-9_]+)\s*[\[{(]+"([^"]*)"/g`. An edge label (`-- "text" -->`) has no bracket before its quote, so it never matches. Split group 2 on `/<br\s*\/?>/` and trim each line. Before the regex runs, skip each statement that `getEdgesInDiagram` skips for `DIAGRAM_KEYWORDS` (`generateSteps.ts:83`), with the same check, so a `subgraph X ["text"]` line never gives a key.

Orphan guard works on PATHS: a first pass computes `BlockFiles` for each box that gets an entry; their `scriptPath` values form `claimedScriptPaths`. In `assertNoOrphanBoxScripts` (`:287`) a file whose full path is claimed is skipped; the old basename checks run for each other file. A script that no label names still throws "is named by no diagram".

## Phase 1 — generator, one agent, test first

All tests go in `tests/generateSteps.test.ts` and use the `generateFrom` helper (`:14-27`). Add `getLabelKeysInDiagram` to the import at `:8`. `H` below is `'%%{init: {"flowchart": {"wrappingWidth": 100000}}}%%\nflowchart TD\n'`. Each test body starts with its step comments and `assert.fail()`, then gets real code.

### Cycle A — choice fold (`getEdgesInDiagram`, `:93-121`, after the line loop)
RED:
- `test_getEdgesInDiagram_foldsAChoiceBoxIntoTheDecisionsNext` — `Q_X --> Q_CHOICE_X_Y --> B_T`; `next` is `{ Q_X: ["B_T"], B_T: [] }`.
- `test_getEdgesInDiagram_leavesAChoiceBoxOutOfTheBoxes` — `boxes` is `["Q_X", "B_T"]`.
- `test_getEdgesInDiagram_namesATargetOnceWhenTwoChoicesReachIt` — `_N` and `_Y` both point at `B_T`; `next.Q_X` is `["B_T"]`.
- `test_getEdgesInDiagram_keepsChoiceTargetsInArrowOrder` — `next.Q_X` is `["B_NO", "B_YES"]`.
- `test_getEdgesInDiagram_foldsAChoiceBoxThatPointsBackAtItsOwnDecision` — `Q_A --> Q_CHOICE_A_N --> Q_A` plus `Q_A --> Q_CHOICE_A_Y --> B_B`; `next.Q_A` is `["Q_A", "B_B"]`.

GREEN: for each `choiceBox` in `boxes` that starts with `CHOICE_BOX_PREFIX`, loop over each `targets` array in `next`; `position = targets.indexOf(choiceBox)`; if `-1`, `continue`; else `targets.splice(position, 1, ...next[choiceBox]!.filter(target => !targets.includes(target)))`. After the loops `delete next[choiceBox]`. Return `boxes` with the choice boxes filtered out.

### Cycle B — label keys (new exported `getLabelKeysInDiagram(diagram): DiagramLabelKeys`, after `:138`)
RED:
- `test_getLabelKeysInDiagram_readsTheFileLineOfASquareLabel` — `B_A["A<br/>file:one/A.ts"]` gives `{ B_A: "one/A.ts" }`.
- `test_getLabelKeysInDiagram_readsTheFileLineOfACurlyLabel` — `Q_A{"A<br/>file:one/A.ts"}`.
- `test_getLabelKeysInDiagram_stopsTheFilePathAtTheNextLineBreak` — `file:one/A.ts<br/>more words` gives `"one/A.ts"`.
- `test_getLabelKeysInDiagram_readsTheBlockLine` — `B_E["E<br/>block:two.mmd::E"]` gives `{ B_E: "two.mmd::E" }`.
- `test_getLabelKeysInDiagram_findsNoKeysInAnEdgeLabel` — `A -- "file:x.ts" --> B`; both records empty.

GREEN: write the function; in `parseDiagrams` (`:248-256`) spread its result into the map value.

### Cycle C — `block:` nodes
Fixture: `one.mmd` = `H + 'Q_A["A<br/>file:one/A.ts"] --> B_E["E<br/>block:two.mmd::E"]\n'`; `two.mmd` = `"flowchart TD\n    E --> F\n"`.
RED:
- `test_generateSteps_writesNoEntryForABlockLineNode` — boxes of `one.mmd` are `["Q_A"]`.
- `test_generateSteps_writesNoStubForABlockLineNode`.
- `test_generateSteps_writesTheBlockLineTargetIntoNext` — `next` of `Q_A` is `["two.mmd::E"]`.
- `test_generateSteps_throwsWhenABlockLineNamesABoxNoDiagramDraws` — `block:two.mmd::NOPE` throws `/names block:two\.mmd::NOPE/`.

GREEN: `remapNextAcrossDiagrams` (`:272-284`) gets a 4th parameter `blockTargetByBox`, checked FIRST in the `map` callback, before the non-null read at `:277`. In `generateSteps`, before the main loop: for each `[box, blockTarget]`, split on `::`; throw `${diagramFile}::${box} names block:${blockTarget}, which no diagram draws` when the diagram is unknown, or (a separate `if`) when its `boxes` lacks the box. For this cycle only, add `if (data.blockTargetByBox[box] !== undefined) { continue; }` as the first statement of the box loop; Cycle D moves it into the first pass.

### Cycle D — `file:` path, stub, template
Fixture: `one.mmd` = `H + 'B_MAKE["make<br/>file:custom/MAKE.ts"] --> B_DONE["done<br/>file:custom/DONE.ts"]\n'`.
RED:
- `test_generateSteps_recordsTheFileLinePathAsTheScript` — `script` matches `/steps\/custom\/MAKE\.ts$/`, `box` is `"B_MAKE"`.
- `test_generateSteps_recordsTheTemplateBesideTheFileLineScript`.
- `test_generateSteps_writesAStubAtTheFileLinePath`.
- `test_generateSteps_writesAFileLineStubThatPrintsItsTemplateOutput` — run the stub as `:66` does; output deep-equals `template.output`; the note is `"MAKE.ts for B_MAKE"`.
- `test_generateSteps_throwsOnAMissingFileLineScriptWhenStubsAreNotAllowed` — throws `/custom\/MAKE\.ts is missing/`.

GREEN:
- New `getPreviousConfig(configPath): StepConfig` beside `:204`; returns `{}` when the file is absent. `getMutatingFromPreviousConfig` is not touched.
- New `getBlockFilesForBox(diagramFile, box, data, previousConfig, stepsRoot, getOwnerFolder): BlockFiles`; this cycle writes two branches: `file:` line, then old-style default path.
- In `generateSteps`, a first pass after `:346` builds `blockFilesByStepKey: Map<string, BlockFiles>` and applies two skip rules in this order: a `block:` node, then the dashed-box rule moved from `:356`.
- Main loop: read `blockFilesByStepKey.get(...)`; `undefined` means `continue`.
- Comment out (never delete): the `:356` `if` block; `:359-361` (the `mkdirSync` becomes `mkdirSync(dirname(scriptPath), { recursive: true })`); `:363-364`.
- `buildStubTemplate` (`:161`) gets a 3rd parameter `scriptFileName`; the note becomes `${scriptFileName} for ${box}`; the caller passes `basename(scriptPath)`.

### Cycle E — orphan guard on paths
RED:
- `test_generateSteps_doesNotThrowWhenAFileLineClaimsAScriptNamedUnlikeItsBox` — a second `run()` does not throw.
- `test_generateSteps_throwsOnAScriptNoFileLineClaims` — write `custom/GHOST.ts`; throws `/custom\/GHOST\.ts is named by no diagram/`.

GREEN: `assertNoOrphanBoxScripts` gets `claimedScriptPaths: Set<string>`; inside the file loop, after the `.test.ts` check: `if (claimedScriptPaths.has(join(stepsRoot, ownerFolder.name, file))) { continue; }`. Move the `:347` call to after the first pass.

### Cycle F — no `file:` line
Generate with the Cycle D fixture; write `one.mmd` again with the `file:` line removed from `B_MAKE`; `run()`.
RED:
- `test_generateSteps_keepsThePreviousScriptPathWhenTheFileLineIsRemoved`.
- `test_generateSteps_keepsThePreviousTemplatePathWhenTheFileLineIsRemoved`.
- `test_generateSteps_throwsOnAPrefixedBlockWithNoFileLineAndNoPreviousEntry` — `H + "B_X --> B_Y\n"` throws `/B_X has no file: line and no earlier steps\.json entry/`.
- `test_generateSteps_writesNoStubWhenAKeptScriptIsMissing` — also delete `custom/MAKE.ts`; throws `/MAKE\.ts is missing/` even with stubs allowed.

GREEN: add the two last branches to `getBlockFilesForBox` (paths from `join(PROJECT_ROOT, previousEntry.script)` and `.template`; `mayWriteStub: false`). In the two missing-file blocks of the main loop add a separate `if (!blockFiles.mayWriteStub) { throw ... }` before the `allowStubs` check. The dashed-box skip stays ordered before the no-`file:`-line throw (an old-style diagram that draws a prefixed box with arrows in only must keep being skipped, as today at `:356`).

Phase 1 exit: `npm run test:baseline` shows no new failure. The real diagrams are still old style, so the byte-equality guard at `tests/generateSteps.test.ts:402` still passes.

## Phase 2 — rename sweep, six parallel edit agents, no test runs

Old name to new id (a block with 2 or more exits is `Q_`):

| Old | New |
|---|---|
| PREAMBLE_STATUS_CHECK | Q_PREAMBLE_STATUS_CHECK |
| IS_TASK_BLOCKED_Q | Q_IS_TASK_BLOCKED_Q |
| IS_TASK_ACTIVE_Q | Q_IS_TASK_ACTIVE_Q |
| PREFLIGHT_OK_Q | Q_PREFLIGHT_OK_Q |
| MARK_TASK_ACTIVE | B_MARK_TASK_ACTIVE |
| DOES_WORKTREE_EXIST_Q | Q_DOES_WORKTREE_EXIST_Q |
| CREATE_WORKTREE | B_CREATE_WORKTREE |
| TAKE_WORKTREE_LEASE | B_TAKE_WORKTREE_LEASE |
| IS_WORKTREE_SAFE_TO_USE_Q | Q_IS_WORKTREE_SAFE_TO_USE_Q |
| TAKE_WORKTREE_LEASE_BEFORE_RESET | B_TAKE_WORKTREE_LEASE_BEFORE_RESET |
| RESET_WORKTREE | B_RESET_WORKTREE |
| IS_PREVIOUS_RUN_RESUMABLE_Q | Q_IS_PREVIOUS_RUN_RESUMABLE_Q |
| REBASE_RESUMED_WORKTREE_ONTO_STAGING | Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING |
| DOES_FENCE_COVER_WORKTREE_Q | Q_DOES_FENCE_COVER_WORKTREE_Q |
| INIT_SUBMODULES_RECURSIVELY | Q_INIT_SUBMODULES_RECURSIVELY |
| DOCUMENT_GENERATION | B_DOCUMENT_GENERATION |

`block:` values. Each equals today's `next` value in the committed `diagram-steps.json`:

| Node | `block:` value |
|---|---|
| `B_REPORT_ONLY_EXIT` | `pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT` |
| `B_FAILURES_EXIT` | `pipeline-failuresExit.mmd::FAILURES_EXIT` |
| `B_IS_DIFFICULTY_7_PLUS_Q` | `pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q` |
| `B_ARE_2_CONFLICT_FIXES_DONE_Q` | `pipeline-commitMergeConflictFixIfNeeded.mmd::ARE_2_CONFLICT_FIXES_DONE_Q` (NOT `pipeline-rebase.mmd`; that would change routing) |

Literal rule for each agent: replace old with new only where this matches: `(?<=["':])NAME(?![\w.])`. It renames quoted literals, `::NAME` tails, and template strings. It leaves file names (`"X.ts"`), import paths, `test_X_...` names, and comments. No file gets a new name. After the sweep, diff each file and confirm no file path or fixture file name changed.

| Agent | Owns |
|---|---|
| P1 diagrams | the two preamble `.mmd` files; `pipeline-commitMergeConflictFixIfNeeded.mmd` and `pipeline-whatDidThePlannerReturn.mmd` in both folders; `diagrams/tackle-tasks/index.html:41` |
| P2 block scripts | the 16 `.ts` + 16 `.template.json` in `scripts/tackle-tasks/preambleStatusCheck/` (not `_packet.ts`, not `fixtures/`); includes `RETURN_TO` at `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:13`; and the two backtick error texts at `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:63,66` |
| P3 block tests | the 16 `.test.ts` in that folder |
| P4 sources + config | `generateSteps.ts:17` (`NEXT_BLOCK_OVERRIDES` key and value), `:21` (`TRANSLATOR_OVERRIDES` key), `:26-31` (`BLOCKS_BY_OWNER_FOLDER.preambleStatusCheck` list); `generateWorkflow.ts:12`; `scripts/hooks/runStepHook.ts:72`; `resetTask.ts:423`; `shared/resumeRun.ts:47,52`; `reportOnlyExit/REPORT_ONLY_EXIT.template.json:3`; `planTheTask/IS_DIFFICULTY_7_PLUS_Q.template.json:3`; `planTheTask/PLAN_THE_TASK.template.json:3`; `skills/tackle-tasks/tackle-tasks.workflow.js:7`; `scripts/tackle-tasks/diagram-steps.json` |
| P5 `tests/` | `generateSteps.test.ts`, `runStepHook.test.ts`, `tackleTasksAcceptance.test.ts`, `generateWorkflow.test.ts`, `workflowAgentOptions.test.ts`, `workflowLivenessHook.test.ts` |
| P6 other script tests | `shared/resumeRun.test.ts`, `shared/SkillBodyEmitter.test.ts`, `resetTask.test.ts`, `planTheTask/PLAN_THE_TASK.test.ts`, `planTheTask/IS_DIFFICULTY_7_PLUS_Q.test.ts`, `commitMergeConflictFixIfNeeded/IS_REBASE_FINISHED_Q.test.ts`, `shared/identityTranslator.test.ts`, `reportOnlyExit/REPORT_ONLY_EXIT.test.ts` |

P1 detail:
- Write `diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd` from `plans/preamble-current.mmd`. Inside the label of each of the 16 blocks append `<br/>file:preambleStatusCheck/<OLD_NAME>.ts`. Append the `block:` line to the 4 next-diagram nodes. Add no `returns_a_prompt` class line (the preamble has no prompt block today).
- Make `diagrams/tackle-tasks-fast/pipeline-preambleStatusCheck.mmd` byte-identical.
- In the two old-style diagrams (both folders): `DOES_FENCE_COVER_WORKTREE_Q` becomes `Q_DOES_FENCE_COVER_WORKTREE_Q`; `DOCUMENT_GENERATION` becomes `B_DOCUMENT_GENERATION`.

P2 detail:
- `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:63`: change the backtick error text to `` `Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING: source repo lock is not held (${outcome.lock})` ``.
- `REBASE_RESUMED_WORKTREE_ONTO_STAGING.ts:66`: change the backtick error text to `` `Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING: rebase failed: ${outcome.failureReason}` ``.

P4 detail:
- `generateSteps.ts:17`: rename the key AND the value (`"Q_IS_TASK_BLOCKED_Q"`). `:21`: rename the key. `:26-31`: comment out the `preambleStatusCheck` list with `// RETIRED: preamble scripts are named by file: lines now.`
- `diagram-steps.json`: apply the literal rule to each `box`, `next`, and `nextBlock` value of the preamble part, and to the two `next` values that point in (`IS_REBASE_FINISHED_Q`, `WRITE_CLARIFY_REQUEST`). Never touch a `script` or `template` path. This hand rename is what keeps the 11 `mutating` flags, because the generator carries the flag by `<diagram>::<box>`.

P5 detail:
- `generateSteps.test.ts:365` and `:369`: change the `note` value to `"PREAMBLE_STATUS_CHECK.ts for Q_PREAMBLE_STATUS_CHECK"`.
- Custom-folder fixture diagrams at `tests/generateSteps.test.ts:358,421,436` become `Q_PREAMBLE_STATUS_CHECK[\"start<br/>file:preambleStatusCheck/PREAMBLE_STATUS_CHECK.ts\"] --> SECOND_BOX`. Fixture script file names stay. `SkillBodyEmitter.test.ts:107,136` (P6) gets the same change.
- Add `test_generateSteps_keepsThePreambleMutatingFlagsOnThePrefixedIds`: read the committed `diagram-steps.json`; collect the preamble boxes with `mutating`; deep-equal to these 11 sorted ids: `B_CREATE_WORKTREE`, `B_DOCUMENT_GENERATION`, `B_MARK_TASK_ACTIVE`, `B_RESET_WORKTREE`, `B_TAKE_WORKTREE_LEASE`, `Q_DOES_FENCE_COVER_WORKTREE_Q`, `Q_DOES_WORKTREE_EXIST_Q`, `Q_INIT_SUBMODULES_RECURSIVELY`, `Q_IS_WORKTREE_SAFE_TO_USE_Q`, `Q_PREAMBLE_STATUS_CHECK`, `Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING`.

## Phase 3 — generate again, one agent, after all of Phase 2

`skills/tackle-tasks/tackle-tasks.workflow.js` is kept by hand. Phase 3 does not write it.

1. `node --no-inspect scripts/tackle-tasks/generateSteps.ts`. It must not throw and must write no new file.
2. `git status --short scripts/tackle-tasks`: only `diagram-steps.json` and the Phase 2 edits show. A new `*.ts` or `*.template.json` means a `file:` path is wrong; correct the label.
3. `git diff scripts/tackle-tasks/diagram-steps.json`: the preamble entries change order (the new file lists nodes by alphabet); 11 `mutating` flags remain.

## Phase 4 — verification, one agent

1. This command prints nothing:
   ```
   git grep -nP '(?<=["'"'"':])(PREAMBLE_STATUS_CHECK|IS_TASK_BLOCKED_Q|IS_TASK_ACTIVE_Q|PREFLIGHT_OK_Q|MARK_TASK_ACTIVE|DOES_WORKTREE_EXIST_Q|CREATE_WORKTREE|TAKE_WORKTREE_LEASE|IS_WORKTREE_SAFE_TO_USE_Q|TAKE_WORKTREE_LEASE_BEFORE_RESET|RESET_WORKTREE|IS_PREVIOUS_RUN_RESUMABLE_Q|REBASE_RESUMED_WORKTREE_ONTO_STAGING|DOES_FENCE_COVER_WORKTREE_Q|INIT_SUBMODULES_RECURSIVELY|DOCUMENT_GENERATION)(?![\w.])' -- scripts skills diagrams tests
   ```
2. This command prints nothing. It finds an old name used as a NODE ID (at the start of a line, after an arrow, after a comma, or after `class`); label text and `file:` text do not match:
   ```
   rg -nP '(^\s*|-->\s*|---\s*|,\s*|^\s*class\s+)(PREAMBLE_STATUS_CHECK|IS_TASK_BLOCKED_Q|IS_TASK_ACTIVE_Q|PREFLIGHT_OK_Q|MARK_TASK_ACTIVE|DOES_WORKTREE_EXIST_Q|CREATE_WORKTREE|TAKE_WORKTREE_LEASE|IS_WORKTREE_SAFE_TO_USE_Q|TAKE_WORKTREE_LEASE_BEFORE_RESET|RESET_WORKTREE|IS_PREVIOUS_RUN_RESUMABLE_Q|REBASE_RESUMED_WORKTREE_ONTO_STAGING|DOES_FENCE_COVER_WORKTREE_Q|INIT_SUBMODULES_RECURSIVELY|DOCUMENT_GENERATION)(?![\w.])' diagrams/tackle-tasks/pipeline-preambleStatusCheck.mmd diagrams/tackle-tasks-fast/pipeline-preambleStatusCheck.mmd diagrams/tackle-tasks/pipeline-commitMergeConflictFixIfNeeded.mmd diagrams/tackle-tasks-fast/pipeline-commitMergeConflictFixIfNeeded.mmd diagrams/tackle-tasks/pipeline-whatDidThePlannerReturn.mmd diagrams/tackle-tasks-fast/pipeline-whatDidThePlannerReturn.mmd
   ```
   Proven on 2026-09-17: 0 hits on `plans/preamble-current.mmd` and `plans/preamble-revised.mmd` (both renamed); 43, 43, 2, 2, 3 and 3 hits on the six live files above (not renamed yet).
3. `cmp` on the two preamble diagram files reports no difference.
4. `npm run test:baseline`. Guards that must pass: `tests/generateSteps.test.ts:402` (byte-equal `diagram-steps.json`), `test_START_STEP_isAKeyInTheRepoConfig`, `tests/stepTemplates.test.ts:106` (dead link) and `:173` (next literal), the fast-folder tests at `tests/generateSteps.test.ts:271-286`.
5. In the output, no `test_stepTemplate_pipeline-preambleStatusCheck_*_producesItsOutputContract` test ran for one of the 11 `mutating` ids.
6. Copy the new diagram into the viewer's `diagrams` folder by hand and open it; it draws with no error line.

Fact to know before the work starts: a task that has a checkpoint, or a `.taskTools/workflows/<N>/steps.json`, written before this change holds the old block names. End or reset each active run first (`git -C <repo> worktree list`, and `jq '[.[]|select(.run.active==true)|.taskNumber]' .taskTools/tasks.json`).

Another fact: `shared/rebaseIntent.ts` (`scripts/tackle-tasks/shared/rebaseIntent.ts`) writes `<worktree>.rebase-intent.json` beside each task worktree, holding an old block key in `targetBlock`. Remove each one before the run: `fd -H '\.rebase-intent\.json$' "${TMPDIR:-/tmp}/taskTools-wt"`.

