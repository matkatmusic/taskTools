# tackle-tasks diagram-vs-code audit

Method: regenerated `steps.json` into a scratch copy of the repo (never touched the real repo's
files) by invoking `generateSteps()` from a copy of `scripts/generateSteps.ts` + `scripts/tackle-tasks/`
+ `diagrams/tackle-tasks/` under
`/private/tmp/.../scratchpad/repo-copy/`. Ran `node --no-inspect scripts/generateSteps.ts`
there (node v26.6.0), which writes its config to `<copy>/scripts/steps.json`.

## Check 1 — regenerate steps.json, diff against committed

| Item | Result |
|---|---|
| Regeneration command | `node --no-inspect scripts/generateSteps.ts` (per `package.json`'s `"steps"` script), pointed at a scratch copy |
| `diff scripts/steps.json <scratch>/steps.json` | **0 lines — byte-identical** |
| Orphan/missing script or template files created by the regen | none (`diff -rq` of `scripts/tackle-tasks` copy vs. real showed no new files) |

**Drift: none.** `scripts/steps.json` is exactly what `generateSteps.ts` produces from the current
`.mmd` files and the current block scripts/templates today.

## Check 2 — per-box: steps.json entry, script exists, template exists, `next` matches .mmd

Because check 1 proved the committed `steps.json` is byte-identical to a fresh regeneration, every
box's entry/script-path/template-path/`next` array is by construction exactly what
`getEdgesInDiagram()` + the remap logic computed from the 19 `pipeline-*.mmd` files. No box lacks a
script or template (`generateSteps.ts` would have thrown per `scripts/generateSteps.ts:341-352`
`allowStubs` guard is irrelevant here since nothing was missing).

Boxes that draw no outgoing arrow in their own file and only forward into another diagram (the
dashed "next diagram" boxes, e.g. `FAILURES_EXIT` referenced from `pipeline-preambleStatusCheck.mmd`)
correctly get **no** entry under that file's key — by design
(`scripts/generateSteps.ts:330-333`), and instead their real entry lives under the diagram that
draws their arrows (e.g. `pipeline-failuresExit.mmd`).

**Drift: none found.**

## Check 3 — `_pipeline-monolith.mmd` vs. the 19 per-diagram `.mmd` files

The monolith is a **different abstraction level, by its own header comment**
(`diagrams/tackle-tasks/_pipeline-monolith.mmd:2-10`): it draws one big box per `agent()` call
(collapsing several real block-boxes into one), with `E<n>_` id prefixes only to keep Mermaid happy
across repeated instances. A literal box-id / edge diff against the per-diagram files is therefore
expected to disagree everywhere (confirmed: 0 raw box-id overlap, 109 raw "edge" mismatches) — that
part is **not** real drift, it's the documented design. Stripping the `E<n>_` prefix and comparing
semantically instead surfaces three real disagreements:

| # | Location | Monolith says | Real diagram says | Verdict |
|---|---|---|---|---|
| 1 | `_pipeline-monolith.mmd:39` (`E2_WHAT_DID_THE_PLANNER_RETURN`) | `"PLAN<br/>difficulty 2 or less"` | `pipeline-whatDidThePlannerReturn.mmd:20`: `"PLAN<br/>difficulty 3 or less"` | **Drift** |
| 2 | `_pipeline-monolith.mmd:76` (`E4_COMMIT_IMPLEMENTATION_IF_NEEDED`) | `"tests pass<br/>difficulty 2 or less"` | `pipeline-commitImplementationIfNeeded.mmd:27`: `"YES<br/>difficulty 3 or less"` | **Drift** |
| 3 | `_pipeline-monolith.mmd` entry4 (`E4_COMMIT_IMPLEMENTATION_IF_NEEDED`) | `"tests fail<br/>reimplement against the amended entry"` --> `E4_IMPLEMENT_TASK` | Real path for a task-test failure: `DO_TASK_TESTS_PASS_Q` NO → `ARE_2_TEST_FIXES_DONE_Q` NO → `AMEND_ENTRY_WITH_FAILING_TESTS` → **`FIX_IMPLEMENT_TASK_TESTS`** (a real `returns_a_prompt` block, `pipeline-fixImplementTaskTests.mmd`) → loops back to `COMMIT_IMPLEMENTATION_IF_NEEDED`, **not** to `IMPLEMENT_TASK`. `FIX_IMPLEMENT_TASK_TESTS` does not appear anywhere in the monolith (confirmed: `grep FIX_IMPLEMENT_TASK_TESTS _pipeline-monolith.mmd` → no hits). The "reimplement against the amended entry" phrase actually belongs to a *different* flow (`pipeline-areTestsFlagged.mmd`'s `AMEND_ENTRY_WITH_CODEX_NOTES → IMPLEMENT_TASK` edge, entry5's story), not entry4's. | **Drift — real bug in the monolith, not just a summarization choice** |

Everything else checked (entry1/preamble, entry3/review-verdict, entry5/areTestsFlagged,
entry6/commitMergeConflictFixIfNeeded, entry7/runFullSuite, the merge-retry-stops-at-2 unrolling,
and every `returns_a_prompt` box once `E<n>_` prefixes are stripped) is a faithful, if condensed,
summary of the real per-diagram files. `returns_a_prompt` marks agree 1:1 (after stripping) except
for finding #3's missing box.

**Bonus finding (not asked for, but load-bearing):** the monolith's own header comment
(`_pipeline-monolith.mmd:2`) says *"The pipeline as `scripts/tackle-tasks/monolith-pipeline.ts` runs
it"* — **that file does not exist** anywhere under `scripts/tackle-tasks/` today. It only exists in
`archive/tackle-tasks-v1_5/scripts/tackle-tasks/monolith-pipeline.ts` (a frozen old copy).
`scripts/tackle-tasks/shared/greenBoxPolicy.ts:80` still lists `"monolith-pipeline"` in its policy
table, so the current tree expects/expected this file to exist and it doesn't. Separately,
`scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:1` carries the comment `// PLAN_THE_TASK, from
_pipeline-monolith.mmd returns_a_prompt` — but `generateSteps.ts` never generates stubs from a
`_`-prefixed file (`getDiagramFileNames` filters those out, `scripts/generateSteps.ts:200-202`), so
that comment is stale, left over from before that convention or from hand-editing.

## Check 4 — `index.html` nav vs. the actual `.mmd` files on disk

`diagrams/tackle-tasks/index.html:40-59` lists exactly: `_pipeline-monolith.mmd` + the 19
`pipeline-*.mmd` files. `find diagrams/tackle-tasks -maxdepth 1 -name '*.mmd'` returns the exact
same 20 names. `diff` of the sorted lists: **empty**.

**Drift: none.** No file is listed but missing from disk; no file on disk is unlisted.

## Check 5 — orphan scripts/templates; boxes with no script

- `assertNoOrphanBoxScripts()` (`scripts/generateSteps.ts:262-298`) ran as part of the check-1
  regeneration and threw nothing — no `.ts` block script exists that names no current box, and none
  sits in the wrong owner folder.
- Independently checked `.template.json` files the same way (generator doesn't check these): **0
  orphan templates** — every `*.template.json` under `scripts/tackle-tasks/<group>/` corresponds to
  a box some `.mmd` still draws.
- Boxes with no script: none — check 1's byte-identical diff proves every box the 19 diagrams draw
  already has both a script and a template on disk (a missing one would have made the regeneration
  either throw, per `allowStubs`, no — default run allows stubs and would have **written** a new stub
  file, which the `diff -rq` on `scripts/tackle-tasks` would have caught; it found nothing new).

**Drift: none.**

## Check 6 — existing test coverage vs. gaps

| Check | Guarded by a test today? | Test file |
|---|---|---|
| `getBoxesInDiagram` / `getEdgesInDiagram` parsing correctness | Yes | `tests/generateSteps.test.ts` (`test_getBoxesInDiagram_*`, `test_getEdgesInDiagram_*`) |
| `generateSteps()` writes correct config, stubs, cross-diagram remap, orphan-script guard | Yes | `tests/generateSteps.test.ts` (most of the ~35 tests in the file) |
| `.taskTools/settings.json` custom `diagramFolder` resolution (task 191) | Yes | `tests/generateSteps.test.ts:230-291` (`test_resolveDiagramFolderSetting_*`, `test_generateSteps_throwsOnAMissingScriptWhenStubsAreNotAllowed`, `test_tackleTasks_walksACustomDiagramFoldersBlocksAndNoneOfTheDefaultPipeline`) |
| **The committed `scripts/steps.json` is up to date with the `.mmd` files (check 1 of this audit)** | **No** — unlike `tests/generateWorkflow.test.ts:130` (`test_generateWorkflow_theCommittedWorkflowIsUpToDate`), there is no analogous `test_generateSteps_theCommittedStepsIsUpToDate` test for `steps.json` itself | none |
| Every block's script matches its `steps.json` template/contract, and edge shape-compatibility block-to-block | Yes | `tests/stepTemplates.test.ts` (per-box + per-edge generated tests) |
| Runtime walk of `steps.json` (hook routing, cross-diagram seams, prompt stop/continue) | Yes | `tests/runStepHook.test.ts`, `tests/runStepStopHook.test.ts` |
| `generateWorkflow.ts` output being in sync with `steps.json` | Yes | `tests/generateWorkflow.test.ts:130` |
| **`_pipeline-monolith.mmd` agreeing with the per-diagram files (check 3 of this audit)** | **No** — no test references `_pipeline-monolith.mmd` at all (the only repo hits for "monolith" are an unrelated code comment, a stale source-file comment, and a policy-table string) | none |
| **`index.html`'s nav list matching the files on disk (check 4 of this audit)** | **No** — no test reads `diagrams/tackle-tasks/index.html`; the one repo hit for "index.html" in `tests/` is `tests/reflowBlockComments.test.ts`, which is about an unrelated `plans/layer2-mockup/index.html` | none |
| Orphan `.template.json` files (check 5, template half) | Partial — the generator's own `assertNoOrphanBoxScripts` only checks `.ts` scripts, not `.template.json` files | `scripts/generateSteps.ts:262-298` (scripts only), no template-orphan test |

## Summary of real drift found

1. **`_pipeline-monolith.mmd:39` and `:76`** say `difficulty 2 or less`; the real diagrams
   (`pipeline-whatDidThePlannerReturn.mmd:20`, `pipeline-commitImplementationIfNeeded.mmd:27`) say
   `difficulty 3 or less`.
2. **`_pipeline-monolith.mmd` entry4** never draws `FIX_IMPLEMENT_TASK_TESTS` and instead routes a
   task-test failure straight to `E4_IMPLEMENT_TASK` with a mislabeled edge borrowed from a different
   flow (`pipeline-areTestsFlagged.mmd`'s codex-notes retry).
3. **`_pipeline-monolith.mmd:2`**'s own header names `scripts/tackle-tasks/monolith-pipeline.ts` as
   the implementation it documents; that file doesn't exist outside `archive/tackle-tasks-v1_5/`, yet
   `scripts/tackle-tasks/shared/greenBoxPolicy.ts:80` still carries a `"monolith-pipeline"` policy
   entry for it.
4. **`scripts/tackle-tasks/planTheTask/PLAN_THE_TASK.ts:1`** carries a stale generated-from comment
   pointing at `_pipeline-monolith.mmd`, which the generator can never actually produce from (leading
   `_` files are excluded from generation).

Everything else — `steps.json` regeneration, every box's script/template/`next` correctness,
`index.html`'s nav completeness, and orphan-script/template detection — showed **no drift**.
