# Handoff — tracer rebuilt, workflow drives the split diagrams, fixtures still stale

Repo `/Users/matkatmusicllc/Programming/taskTools-86`, branch `fix-tackle-tasks-workflow-script-imports`.

My work is **uncommitted**, 6 files. The previous session's 8 files were committed as `37acd78 WIP`.

Read `plans/handoff-workflow-11.md` first for everything before this session. It is still accurate
except where this document says otherwise.

## What I did

### 1. The workflow is a real driver now

`skills/tackle-tasks/tackle-tasks.workflow.js` was a trace-only skeleton carrying
`/** Real mode is deliberately not built. */`. It now covers prompt paragraphs 18 to 97 as a state
machine over the 12 post-preamble diagrams.

- The **6 `[S]` paragraphs** — 23, 30, 36, 45, 58, 63 — are real `agent()` calls. Each prompt is two
  lines: run `AgentPromptEmitter.ts` with the payload on quoted-heredoc stdin, follow what it prints.
  Schemas enforce the return shape.
- The **90 `[C]` paragraphs** call `notWired()`, which throws naming its diagram box. Nothing takes a
  happy path silently. `decide()` is the decision-returning variant.
- Back-edges — replan, reimplement, re-rebase, clarify — are a `PIPELINES` map plus a `current`
  string, because the diagrams are a graph, not a chain.

**Edit the template, never the output.** `skills/tackle-tasks/tackle-tasks.workflow.js` is generated
from `scripts/tackle-tasks/tackle-tasks.workflow.template.js` by
`node scripts/tackle-tasks/generateTaskWorkflow.ts`. I lost time learning that; the handoff before
this one did not mention it.

### 2. Diagram labels are spliced, not copied

`generateTaskWorkflow.ts` scans the template for `L.<NODE_ID>` and splices a label map read from the
diagrams, next to the validator splice it already did. 71 labels today.

Write `L.DID_REBASE_REPORT_CONFLICTS` in the template and the generator resolves it. A typo fails the
build with `tracePipeline: no diagram node named "..."`, never a run. Do not hand-copy a label.

### 3. `tracePipeline.ts` rewritten for the split diagrams

This was the ENOENT crash in `plans/handoff-workflow-11.md` gotcha 1. `DIAGRAM_FILES` named five
diagrams that commit `e527823` deleted, and it read them in a **top-level** loop, so every importer
died at module load.

The walk now **starts at the plan pipeline**, because the preamble moved into
`PreambleDataEmitter.ts:runPreamble` and the workflow no longer covers it.
`tests/workflowMatchesTracer.test.ts` does `deepEqual` on the whole trace, so the two spans must be
identical — do not re-add preamble boxes to one without the other.

Deleted: `RECEIPT_NODES` (150 lines) and the agent-retry machinery. **Zero** split diagrams contain
`*_RECEIPT_TRUSTED` or `DID_*_RETURN_A_RESULT` nodes; v1.5 dropped receipt-validity boxes and
replaced agent retry with one dotted `AGENT_ERRORED` edge. There are 6 agent boxes now, not 8.

New `PipelineDecisions`:

```
plannerOutcome  PLAN | CLARIFY | ERROR      planVerdict     ACCEPT | AMEND | SCRAP
taskTestsPass   boolean[]                   testsFlagged    boolean[]
lockAcquired    boolean[]                   rebaseConflicts boolean[]
rebaseFinished  boolean[]                   suitePasses     boolean[]
fenceHeld       boolean                     publicationState ALL | NONE | SOME LANDED
agentErrors     Partial<Record<AgentBoxName, boolean[]>>
```

### 4. FAKE mode restored, and verified against the tracer

`notWired()` throws in real mode and reads `args.fake` in fake mode, so one file has both behaviours
without lying about either.

I diffed the workflow's fake trace against the tracer across **20 paths** — happy, clarify once,
clarify stuck, amend then accept, plan scrapped, tests fail once, tests red, flagged once, tests
flagged, lock lost, conflict once, rebase stuck, suite fail once, suite red, fence violation, merge
retry, merge failed, partially published, planner errored, suite fixer errored. All 20 match line for
line. The comparison script is throwaway; rebuild it from
`tests/workflowMatchesTracer.test.ts` if you need it again.

### 5. `emitPipelineOutput.ts` runs again

```
node scripts/tackle-tasks/emitPipelineOutput.ts <N> --path safe-existing-worktree
```

Writes `plans/diagram/output renders/pipeline-output-task-<N>-<path>.md`: the pipeline trace, the
annotated skill body, and **the plan agent's real prompt**.

Three changes made that work:

- `stagePath` now also calls `generateTaskDocs`. It created a worktree but never wrote the brief, and
  `loadPreparedTask` refuses to run without `<worktree>/plans/brief-<N>.md`.
- New exported `planAgentPrompt(taskNumber, projectRoot)` builds the role `plan` prompt from the
  convention worktree path. Returns a note instead when the path stages no worktree.
- `matchPathNumber`, `derivePreambleDecisions` and `withDownstreamDefaults` are **gone**. They matched
  against the 459 stale fixtures. The render prints the trace directly and the file is named by task
  and path.

Because the tracer starts at `plan`, the four `STAGEABLE_PATHS` no longer change the trace at all.
They still decide whether a worktree and brief exist for the **prompt** half, so staging still earns
its place.

### 6. `SkillBodyEmitter.ts`

Now uses `resolveTaskRun` instead of `parseTaskNumberArgument` + `generateRunId`, and passes
`worktree`, `projectRoot`, `sourceBranch` and `runId` to the workflow. `AgentPromptEmitter`'s CLI
rejects a payload missing any of those four.

### 7. A real bug the tracer caught

The failures exit hardcoded `did ANY of this task's work land?: NO`. But `partially-published`
arrives there **because** work landed, so per paragraph 86 it must take the YES edge and write the
publication outcome, discarding the incoming exit type. Fixed in both the tracer and the workflow.

## Test state — read this before you panic

**537 failing, against a 39 baseline.** Every one is in a bucket the user explicitly told me to skip:

- **459** — `workflow matches tracer: <fixture>`, one per stale fixture in
  `scripts/tracePipelinePaths.json`
- **41** — `tests/tracePipeline.test.ts`, `test_stepPipeline_*`, `tests/emitPipelineOutput.test.ts`

Nothing outside those two buckets moved. I verified name by name against a stashed baseline, with
durations stripped:

```
git stash push -q <your files>
npm test 2>&1 | rg '^✖' | sed -E 's/ \([0-9.]+m?s\)$//' | sort -u > before.txt
git stash pop -q
```

**Strip the durations or `comm` is useless** — every line differs by its millisecond count.

Note the count jumping from 39 is partly an illusion: 3 of the old 39 were whole-file *crashes*
printing one `✖ <path>` line each. Fixing the import turned them into individually-named failures.
That looks like a regression and is the opposite. `plans/handoff-workflow-11.md` warns about exactly
this.

## What is left

1. **Regenerate the 459 fixtures.** `scripts/generatePipelinePaths.ts` still builds the old decision
   space. This clears the 459 failures.
2. **`scripts/tackle-tasks/stepPipeline.ts` and `scripts/generatePipelinePaths.ts` do not
   typecheck** — both import the deleted `ReceiptName`. These are the only two non-test files still
   broken.
3. **Rewrite `tests/tracePipeline.test.ts`** (1098 lines). It asserts the old shape throughout.
4. **`tests/emitPipelineOutput.test.ts`** imports the removed `matchPathNumber`.
5. **The `[C]` runner.** Still the big one, and still not designed. 90 boxes throw. The user chose
   "skeleton and 6 agents only" for that pass deliberately, to see the shape before making it
   executable.
6. Still open from handoff 11: `checkResumedWorktreeFence.ts` has no test, and the 5 missing exit
   types are not in `taskRunState.ts:TaskExitType`.

## Gotchas that cost me time

**The comment-reflow hook joins block comments too**, not only `//` runs. A `/* */` spanning three
lines is joined into one and then blocked at 20 words. Every comment in a file it touches must be one
line under 20 words. Do not put a blank `//` between sentences to defeat it — the user will call that
out. It also reflows HTML comments inside a template literal.

**`node --check` fails on the workflow** with `Illegal return statement`. That is correct: top-level
`return` is what the sandbox expects. Wrap the source in a function to syntax-check it.

**A test run deletes leftover task worktrees.** I demonstrated the plan prompt against a stale
`task-35` worktree, then `npm test` tore it down mid-session and the demo stopped working. Use
`emitPipelineOutput`'s staging rather than relying on one being there.

**`tests/tackle-tasks/workflowStructure.test.ts` forbids any escaped backtick in the workflow
source.** Writing ``Run `Bash(...)` `` in an agent prompt fails it. Plain text, no backticks.

**Run `npm test`, not `bun test`,** and do not gate on `rg '^✖'` — it reports "all passing" on a red
suite.
