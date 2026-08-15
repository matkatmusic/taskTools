# Handoff: pipeline diagrams -> tracePipeline -> the real workflow

Written 2026-08-14. Branch `fix-tackle-tasks-workflow-script-imports`, worktree
`/Users/matkatmusicllc/Programming/taskTools-86`.

## The goal, in two steps

1. **Total path coverage.** Every path through every diagram has a test. The tests derive the
   path set from the `.mmd` files themselves, so the diagrams are the single source of truth.
2. **Make the real code emit the same strings.** The workflow scripts and the emitters produce
   byte-identical output to `tracePipeline` for the same state (task number, repo state). Run
   the workflow per phase and diff it against the tracer; identical means correct.

## Decisions already made — do not re-litigate

| Decision | Answer |
|---|---|
| Step wording | The tracer emits **each node's label verbatim** from the diagram. One vocabulary, owned by the `.mmd` files. |
| What "every path" means | **Each edge traversed at most twice.** Matches `MAX_ATTEMPTS`: every loop is capped at 2 attempts, so 2 traversals covers first-try and second-try. |
| Where the path set comes from | **Parsed from the `.mmd` files at test time.** Editing a diagram fails the build on the next run. No committed intermediate. |
| How step 2 avoids drift | **One shared step-name module**, generated from the diagrams, imported by both the tracer and the workflow/emitters. They cannot drift. |
| The `%%` header rules | **Out of scope for now.** Test the graph only: boxes, edges, paths. The header invariants stay as prose. |

## Current state — green

- Six diagrams in `plans/diagram/`, all rendering:
  `pipeline.mmd` (overview), `pipeline-preamble.mmd`, `pipeline-planning.mmd`,
  `pipeline-implementTest.mmd`, `pipeline-rebaseMerge.mmd`, `pipeline-exitWorkflow.mmd`
- `scripts/tracePipeline.ts` — walks all five sub-pipelines, prints one line per box
- `scripts/tracePipelinePaths.json` — 39 named fixtures
- `tests/tracePipeline.test.ts` — 42 tests (39 paths + 3 guards), all passing
- `npx tsc --noEmit` clean for these files

```
node scripts/tracePipeline.ts --list      # the 39 path names
node scripts/tracePipeline.ts <name>      # one path
node scripts/tracePipeline.ts --all       # every path
node --test tests/tracePipeline.test.ts   # 42 pass, 0 fail
```

Diagrams render live at `http://127.0.0.1:8777/` (a `python http.server` in `plans/diagram`).
`index.html` reads the filename from the query string and has a nav strip across the top.

## Diagram conventions — follow them, do not reinvent

Node ids are `ALL_CAPS_WITH_UNDERSCORES`, derived from the node's own label.

Colour classes, identical in every file:

| class | colour | used for |
|---|---|---|
| `script` | green | command / script boxes |
| `agent` | orange | boxes an agent runs |
| `decision` | yellow | decision diamonds |
| `receipt` | white, black text | `Receipt: { ... }` blocks |
| `output` | blue | `Input:` and `Output` blocks |
| `pass` / `nopass` | green / dark red | YES/NO blocks — green continues toward the receipt, red ends in the exit workflow |
| `fail` | bright red | the `exit workflow` block |
| `verdict` | grey | SCRAP2-style second-strike blocks, and verdict values |

Structural patterns, applied everywhere:

- Every yes/no decision routes through explicit `YES` / `NO` **blocks**, never bare edge labels.
  Bare `yes`/`no` label text collides in layout.
- Two-strike loops are drawn `First X?` (diamond) -> `2nd X?` (block) -> exit workflow.
- A command whose result is unknown until a diamond reads it is prefixed `Try: `.
- Every receipt-producing block follows:
  `producer -> Output -> Receipt: {...} -> is the ... receipt structure valid? ->`
  `YES -> Output -> Receipt: {...}` (re-emitted, trust established) `-> next block`
  `NO  -> Output -> Receipt: { exitType, exitNote } -> exit workflow` (never validated)
- The failure receipt is never validated — that would feed the exit workflow into itself.

## Where the diagrams are AHEAD of the code

These are real work items for step 2, not formatting. The diagrams are the source of truth, so
the code changes.

1. **No `accept` verdict exists.** `scripts/tackle-tasks/planArtifacts.ts:129` rejects any verdict
   that is not `"amend"` or `"scrap"`. The planning diagram draws all three.
2. **Nothing writes codex scrap notes into the task brief.** The diagram has
   `script adds the codex scrap notes to the task brief`; no script does this. Without it the
   replan repeats the first plan's mistakes.
3. **The two-box lock does not match the code.** The diagram draws
   `can the source repo be locked?` then `lock the source repo`, each with its own two-strike
   wait. `acquireSourceRepoLock` in `scripts/tackle-tasks/sourceRepoLock.ts` returns four
   outcomes from one call: `acquired`, `already-held-by-me`, `held`, `recoverable`.
4. **No receipt-structure validators** exist for the fix / amend / conflict-fix receipts.
   Only `validatePlanFile.ts` and `validateCodexReview.ts` exist today.
5. **Commit message in the amend receipt** is marked `TO BUILD` in
   `pipeline-implementTest.mmd` rule 7. The amender is the only thing that knows which reviewer
   notes it applied; today every repair commit gets the same derived message.

## Blockers sitting directly in step 2's path

- **33 tests are already red**, and were before any of this work:
  `tests/tackle-tasks_bootstrap.workflow.test.ts` and `tests/tackle-tasks/SkillBodyEmitter.test.ts`.
  The workflow files are quarantined in `skills/tackle-tasks/failed/`, and `SkillBodyEmitter.ts`
  holds hand-written pseudocode that does not compile. Deal with this first.
- **`scripts/tackle-tasks/sourceRepoLock.ts:72`** calls `mkdirSync(dirname(projectRoot/.git/...))`,
  which throws `EEXIST` when the project root is a linked git worktree — because `.git` is then a
  file, not a directory. `taskTools-86` IS a linked worktree of `~/Programming/taskTools`, so this
  fires on any exit that releases the source lock.

## Ordered plan

**Step 1 — the path extractor and total coverage**

1. First, actually search for an existing mermaid path-enumeration tool. Nobody has verified none
   exists. Note that no off-the-shelf tool will know the edge-at-most-twice bound, the YES/NO
   block convention, or the receipt/validator pattern, so expect to own that part regardless.
2. Write the extractor. The `.mmd` files are very regular — one edge per line, forms are
   `A --> B`, `A -- "label" --> B`, `A -.-> B` — so a small parser beats pulling in mermaid's
   internals. It must return, per diagram, the node labels and the edge list.
3. Enumerate every path with each edge used at most twice.
4. Rewrite `tracePipeline.ts` so every line it prints is a node label taken verbatim from the
   diagram, not its own wording. This changes every string in the tracer and in all 42 tests.
5. Tests parse the `.mmd` at test time and assert the tracer covers exactly the enumerated path
   set — no missing path, no extra path.

**Step 2 — one shared module**

6. Generate `scripts/tackle-tasks/pipelineSteps.ts` (name to taste) from the diagrams: the
   canonical string for every box.
7. `tracePipeline.ts` imports it.
8. The workflow scripts and `SkillBodyEmitter.ts` / `PlannerBodyEmitter.ts` import it and emit
   the same strings at the same points.
9. Close the five gaps listed above, since the workflow cannot emit a step it does not have.
10. Add the diff test: run the workflow per phase against a known state, run the tracer against
    the same decisions, assert the output is identical.

## Notes

- `npm test`, not `bun test` — bun reports a false failure in `mergeTaskWorktrees`.
- Do not chase the 33 red tests as regressions from this work; they predate it.
- The fixture generator used to build `scripts/tracePipelinePaths.json` is a scratch script and
  was not committed. Step 1 replaces it with the diagram-derived extractor anyway.
