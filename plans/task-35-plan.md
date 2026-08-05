# Task 35 Plan: Production cutover to the recursive repository workflow

## Planner's constraint (read this first)

This plan was written from `plans/brief-35.md` only — no other file was read. The brief gives the
*current* full contents of `scripts/repositoryBranches.ts`, `scripts/taskGroups.ts`,
`scripts/prepareTasks.ts`, `scripts/mergeTaskWorktrees.ts`,
`skills/tackle-tasks/tackle-tasks.workflow.js`, `skills/tackle-tasks/SKILL.md`, and the two test
files — that content is trustworthy and quoted below where it matters. It does **not** show the
Phase 1–3 modules this task wires in: `scripts/canonicalTaskGroups.ts`, `scripts/runFinalizer.ts`,
`scripts/runConsolidation.ts`, `scripts/operationPush.ts`, `scripts/basePublication.ts`,
`scripts/taskArchival.ts`, `scripts/legacyManifest.ts`, the repository-graph discovery module the
brief calls "graph-based equivalents" for `collectRepositorySources`/`submodulePaths`/
`createBranchInEveryRepository`, or the approval-gate module from task 31
(`tests/runAuthorization.test.ts` exists on this branch already).

**The first action of every step below is: read the real module(s) named in that step, in full,
to learn their actual exported names, parameter shapes, and return types.** Do not guess a
signature and code against the guess — the brief cannot confirm it, so confirm it from the file
itself before writing a call site against it. Where this plan describes a field or behavior those
modules "should" provide, that is the requirement to satisfy, not an assumed signature.

## Ground rules for every step

- TDD, red-green, per `~/.claude/guides/tdd.md`: update/add the failing test first, then write
  the minimum code to turn it green, then run `node --test tests/` before moving to the next step.
- Surgical edits only. Do not rewrite a file wholesale when a call site swap suffices. Do not
  touch formatting/logic the step doesn't require.
- Do not delete the current flat-path logic outright — Step 6 requires it stay reachable as the
  legacy path. "Cutover" means production call sites route to the new modules by default with the
  old behavior preserved for legacy manifests, not that old code is deleted in this task.
- Every exported name the two existing test files import must either keep working or be updated
  in the same commit as the test file that imports it (see the import lists in Step 3 and Step 4).
- ponytail: do not invent a new version-flag system, a new manifest-detection scheme, or new
  abstractions beyond what each named module already needs to do its one job. If a step turns out
  to need less code than described here because the real module already does it, take the smaller
  diff and say so.

## Order of work

1. `scripts/repositoryBranches.ts` — graph-based discovery/branch creation
2. `scripts/taskGroups.ts` — grouping via `scripts/canonicalTaskGroups.ts`
3. `scripts/prepareTasks.ts` — call sites for discovery, worktree/branch creation, workflow args
4. `scripts/mergeTaskWorktrees.ts` — finalization/publication pipeline
5. `skills/tackle-tasks/tackle-tasks.workflow.js` + `SKILL.md` — approval gate before finalization
6. `scripts/legacyManifest.ts` routing — non-destructive refusal for old manifests
7. Version flip, gated on the full suite

Each step is a separate commit-sized unit; do not start step N+1 with step N's tests red.

---

## Step 1 — `scripts/repositoryBranches.ts`

Current exports (full bodies are in the brief): `RepositorySource` type, `currentBranchName`,
`submodulePaths` (shells out to `git submodule foreach --recursive`), `collectRepositorySources`
(flat list: parent + `submodulePaths`, throws naming every detached-HEAD repo),
`createBranchInEveryRepository` (loops the given paths, `git checkout -B`).

1. Locate the Phase 1–3 repository-graph discovery module (search `scripts/` for exports that
   return a graph/tree of repositories rather than a flat path array — check
   `plans/archived/` and `.taskTools/completedTasks.json` for the task that built it if the name
   isn't obvious from a directory listing).
2. Decide, from that module's actual exports, whether `collectRepositorySources`,
   `submodulePaths`, and `createBranchInEveryRepository` become thin wrappers that call into it, or
   whether callers switch imports directly to the graph module and these three are deleted. Prefer
   thin wrappers if the graph module's return shape differs from `RepositorySource[]` — it keeps
   `path`/`sourceBranch` field names stable for `mergeTaskWorktrees.ts`'s `findSourceBranch` and
   for the two test files' repository-source assertions (`paths.includes("")`,
   `paths.includes("vendor")`).
3. Preserve the two behavior contracts the current tests pin:
   - a detached-HEAD repository still causes a throw that names every detached path (parent shown
     as `"(parent)"`), not a silent skip.
   - `createBranchInEveryRepository` still uses `-B`, not `-b` — a branch left by an earlier run
     must reset onto HEAD, never be reused as-is (see the comment on that function in the brief).
4. Update `tests/prepareTasks.test.ts`'s repository-source assertions only if the graph module's
   `RepositorySource`-equivalent shape gains fields — keep it additive.
5. Run `node --test tests/` — confirm green before Step 2.

## Step 2 — `scripts/taskGroups.ts`

Current export: `groupTasksByFileOverlap` (union-find over declared `files` arrays, one bucket for
tasks with no declared files, sorted by lowest task number, `groupId` assigned 1..n).

1. Read `scripts/canonicalTaskGroups.ts` in full.
2. If it returns the same `TaskGroup` shape (`groupId`, `taskNumbers`, `filePaths`, `scope`),
   swap `prepareTasks.ts`'s import from `groupTasksByFileOverlap` in `taskGroups.ts` to the
   equivalent export in `canonicalTaskGroups.ts`, and leave `taskGroups.ts` in place only if
   something else still imports it (grep for other importers before deleting it).
3. If `canonicalTaskGroups.ts` returns a richer, graph-aware grouping (e.g. per-repository or
   per-submodule groups), that shape change cascades into `PreparedGroup`/`WorkflowArguments` in
   Step 3 — note the actual new fields there so Step 3 threads them through instead of dropping
   them.
4. Any test currently exercising `groupTasksByFileOverlap`'s union-find semantics (not shown in
   the brief — check `tests/` for a `taskGroups.test.ts`) must keep passing against the new
   grouping function's output for the same inputs, or be updated deliberately if the new grouping
   is intentionally different — do not let it go red silently.
5. Run `node --test tests/` — confirm green before Step 3.

## Step 3 — `scripts/prepareTasks.ts`

`tests/prepareTasks.test.ts` imports `buildWorkflowArguments`, `createWorktreeForGroup`,
`generateRunId`, `mergeScriptPath`, `selectRequestedTasks`, `writeTaskBriefFile` — every one of
these names must still resolve after this step, even where its body changes.

Three call sites change, in this file, using whatever Step 1/2 produced:

1. **Discovery** — `buildWorkflowArguments`'s `collectRepositorySources(repoRoot)` call, and
   `createWorktreeForGroup`'s `submodulePaths(worktreePath)` call, switch to the graph-based
   versions from Step 1. Keep the call shape identical unless Step 1 changed the signature; if it
   did, that's a one-line, deliberate change here, not a redesign of `buildWorkflowArguments`.
2. **Worktree/branch creation** — `createWorktreeForGroup`'s
   `createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName)`
   call updates the same way.
3. **Grouping** — the CLI path's `groupTasksByFileOverlap(tasks)` call in `runAsCli` switches to
   Step 2's grouping function.
4. **Workflow arguments** — `WorkflowArguments`/`PreparedGroup` gain whatever new fields Step 5
   needs the workflow to receive (recursive graph metadata, hook mode, recovery refs — see Step
   5). Add them to `buildWorkflowArguments`'s return without breaking
   `mergeTaskWorktrees.ts`'s `CliInput`/`WorkflowArguments` re-import (Step 4 updates that side).

Update `tests/prepareTasks.test.ts` assertions that inspect `RepositorySource`/`TaskGroup` shapes
to match Steps 1–2's actual output only where genuinely necessary —
`test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch` is the one most likely to need a
shape update if Step 1's graph module changes the `RepositorySource`-equivalent fields.
`test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory` is
different: per the brief's locked design decision 1, this exact test **must keep passing
unchanged, with zero edits to the test itself** — do not touch it. If a Step 1/3 change would
require editing this test to keep it green, that change is wrong; keep the detached-HEAD refusal
firing before graph discovery and before any worktree directory is created, exactly as it does
today, so this test's current assertions hold as-is.

Run `node --test tests/` — confirm green before Step 4.

## Step 4 — `scripts/mergeTaskWorktrees.ts`

`tests/mergeTaskWorktrees.test.ts` imports `mergeGroupBranchIntoRepo`,
`mergeSubmoduleBranchIntoRepo`, `removeWorktreeAndBranch`, `resolveGitlinkConflicts`, plus
`createWorktreeForGroup`/`currentBranchName` from the files Steps 1/3 touch. This is the largest
behavior change: `runAsCli` currently merges branches directly (checkout, `git merge`, gitlink
conflict resolution, submodule merge, then `appendRunMetricsRecord`) and prints
`{ merged, conflicts }`.

1. Read `scripts/runFinalizer.ts`, `scripts/runConsolidation.ts`, `scripts/operationPush.ts`,
   `scripts/basePublication.ts`, `scripts/taskArchival.ts` in full. Map each to the pipeline stage
   its name implies:
   - `runConsolidation.ts` — bringing group branches (and submodule branches) together, i.e. the
     current `mergeGroupBranchIntoRepo`/`mergeSubmoduleBranchIntoRepo`/`resolveGitlinkConflicts`
     responsibility.
   - `runFinalizer.ts` — orchestrates consolidation to completion (decides merged vs. conflicted
     per group, deepest-submodule-first ordering — currently the manual
     `.sort((a, b) => b.split("/").length - a.split("/").length)` hack in `runAsCli`).
   - `operationPush.ts` — pushing the finalized branches.
   - `basePublication.ts` — publishing the result (this is very likely where
     `appendRunMetricsRecord`'s current call belongs now, or it stays a sibling step — check
     whether `basePublication.ts` already calls the metrics recorder before adding a duplicate
     call site).
   - `taskArchival.ts` — very likely where `removeWorktreeAndBranch` (or its replacement) and the
     eventual `close-tasks` handoff data comes from.
2. Per the brief's locked design decision 2, `mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`,
   `resolveGitlinkConflicts`, and `removeWorktreeAndBranch` stay exported from
   `mergeTaskWorktrees.ts` with their current signatures and behavior **unchanged** — do not move
   them, do not change their parameters, do not touch `tests/mergeTaskWorktrees.test.ts`'s imports
   or any of its assertions. That file must keep passing with **zero edits**. Only `runAsCli`'s
   orchestration body changes: it still needs a way to produce the same effective outcomes these
   four functions produce today (clean merge succeeds, conflicting merge aborts and reports
   conflicted paths and a `failureReason`, gitlink conflicts on submodule paths auto-resolve,
   non-submodule conflicts abort, later groups still get attempted after an earlier group
   conflicts, worktree survives a conflict, cleanup removes both worktree and branch after a clean
   merge). Rewire `runAsCli` to get there via the five Phase 1–3 modules — translate the flat
   `WorkflowArguments`/`CliInput` into whatever graph/occurrence shape they need, call them in
   dependency order, and keep (or internally reuse) the four functions above as the actual git
   primitives if the new modules don't already reimplement equivalent primitives themselves.
3. `SubmoduleConflict`/`MergeOutcome` types stay as they are — decision 2 doesn't ask for a type
   change, and the test file's assertions depend on their current shape.
4. The CLI's final `process.stdout.write(JSON.stringify({ merged, conflicts }))` output shape does
   **not** change — decision 2 is explicit that this script "writes the same stdout shape it writes
   today." `readyForApproval` and the rest of the approval-gate payload are Step 5's concern,
   upstream of this script even being invoked — `mergeTaskWorktrees.ts` only ever runs after
   approval, as the finalization step, and its own output contract to whatever calls it stays
   `{ merged, conflicts }`.

Run `node --test tests/` — confirm green before Step 5.

## Step 5 — `skills/tackle-tasks/tackle-tasks.workflow.js` + `skills/tackle-tasks/SKILL.md`

Today the pipeline is `Plan → Implement → Typecheck → Merge`, and the workflow's `return` at the
bottom is `{ merged, conflicts, needsClarification, notRelevant, partial, blocked, typecheck }` —
merge already happened by the time the user sees anything. That must change to: preparation
returns recursive graph metadata, hook mode, recovery refs, test receipts, review handoffs, and
`readyForApproval`; the user approves; only then does finalization (Step 4's pipeline) run.

1. Read the task-31 approval-gate module (state digest, drift invalidation —
   `tests/runAuthorization.test.ts` already exists on this branch) to learn its exported check/gate
   function and what it needs as input (likely the same state digest concept the brief's task
   description is naming "recursive graph metadata"/"recovery refs" around).
2. Split the current bottom-of-file merge step into two stages:
   - **Prepare-for-approval stage** (replaces today's single `mergeResult = await agent(...)`
     call): gathers recursive graph metadata (from Step 1/3's graph discovery), hook mode,
     recovery refs, test receipts (from the `Typecheck` phase's existing `typecheckResults`, plus
     whatever worker-level test evidence Step 5.1's module expects), and review handoffs (likely
     assembled from `needsClarification`/`partial`/`blocked`, or from a review-handoff shape the
     approval module defines — confirm from its actual type). Computes `readyForApproval` from the
     approval-gate module's check. Returns this instead of calling `mergeScript`.
   - **Finalize stage**: a second workflow entry point (or a second phase this same workflow
     resumes into once the caller — `SKILL.md` — signals approval) that runs Step 4's finalization
     pipeline and returns its result. Do not call it automatically at the end of the same run; the
     brief is explicit that "the approval gate runs before finalization."
3. Replace `MERGE_SCHEMA` with a schema matching the new prepare-for-approval return shape; keep
   naming symmetric with the fields the brief lists (`readyForApproval` boolean at minimum, plus
   whatever the approval-gate module's own output type calls the other five).
4. Update `SKILL.md`'s workflow section: today it says "Call Workflow ... Present merged,
   conflicts, needsClarification and blocked to the user ... ONLY after the user approves, invoke
   close-tasks." Rewrite to: call Workflow, present the graph metadata/test receipts/review
   handoffs and `readyForApproval` to the user, get approval, then invoke whatever re-entry point
   Step 5.2 defined to run finalization, present its merged/conflicts result, and only then invoke
   `close-tasks` for the tasks that finalized cleanly.
5. No test file for `tackle-tasks.workflow.js` is shown in the brief — if none exists, this step's
   correctness is verified by Step 4's finalization tests plus a manual/CLI dry run (workflow.js
   isn't unit-testable in isolation the way the `.ts` scripts are; don't invent a test harness for
   it beyond what already exists — ponytail: check first whether one already exists before adding
   one).

## Step 6 — `scripts/legacyManifest.ts` routing

1. Read `scripts/legacyManifest.ts` in full — it already exists; learn what shape of manifest it
   recognizes as "legacy" and what it does with one.
2. At the point where the new production path first receives an incoming
   manifest/`WorkflowArguments`-like JSON (top of `mergeTaskWorktrees.ts`'s `runAsCli`, and/or
   `tackle-tasks.workflow.js`'s `ARGS` parsing), detect a legacy-shaped manifest (missing the new
   graph-metadata/approval fields Step 5 added, or an explicit version marker below the new one)
   and dispatch through `legacyManifest.ts`.
3. Two outcomes only:
   - `legacyManifest.ts` recognizes it as compatible with the preserved old tooling (Steps 1–4's
     prior behavior, which per the ground rules was not deleted) — route it there unchanged.
   - it doesn't recognize it — refuse **non-destructively**: throw/return an error that names the
     manifest as unrecognized and includes recovery instructions (the worktree path(s) and branch
     name(s) the manifest points at, so a human can clean up or resume by hand). Do not remove any
     worktree or branch on this path.
4. New test (place alongside whichever file owns this dispatch — likely
   `tests/mergeTaskWorktrees.test.ts` or a new `tests/legacyManifest.test.ts` if one doesn't exist
   yet): a legacy manifest fed to the entry point is refused, the thrown/returned message contains
   recovery instructions, and `existsSync(worktree)` is still `true` afterward (the worktree
   survives). Model this test on the existing conflict tests' pattern of setting up a real temp
   repo via `mkdtempSync`/`git init`.

Run `node --test tests/` — confirm green before Step 7.

## Step 7 — Version flip, gated on the full suite

1. Locate the existing "manifest/workflow version" marker (grep for `version` across `scripts/`,
   `skills/tackle-tasks/`, and `scripts/legacyManifest.ts` specifically, since it's the thing that
   has to tell old from new). Do not introduce a new versioning mechanism if one is already there
   for `legacyManifest.ts` to compare against — reuse it.
2. This flip is the last commit of the task, isolated from all logic changes above, so it's
   revertible independently: bump/flip that single marker only.
3. Before writing that commit, run the complete suite (`node --test tests/`, plus whatever the
   repo's typecheck command is per `prepareTasks.ts`'s `DEFAULT_TYPECHECK_COMMAND`) and confirm
   every test — including the Step 6 legacy-refusal test and the pre-existing
   `tests/runAuthorization.test.ts` — passes. Per ponytail's "leave one runnable check" rule, wire
   this as an actual gate rather than a promise: the version-flip commit should be impossible to
   produce without a green run, e.g. a small script (or an existing pre-commit/CI hook, if one
   already runs the suite — check before adding a new one) that runs `node --test tests/` and
   refuses to proceed on nonzero exit. Do not build a new CI system for this — a single guarded
   script or reuse of an existing hook is enough.

## Tests checklist (from the brief's Tests section, made concrete)

- [ ] `tests/prepareTasks.test.ts` passes against the Step 1–3 interfaces.
- [ ] `tests/mergeTaskWorktrees.test.ts` passes against the Step 4 interfaces.
- [ ] A test asserts the workflow's return before approval is `{ readyForApproval: true|false, ... }`
      shaped — not a merge result — matching Step 5.
- [ ] A test asserts a legacy manifest is refused non-destructively, with recovery instructions in
      the message, and its worktree still exists afterward (Step 6).
- [ ] The version marker only changes in a commit made after a full green `node --test tests/` run
      (Step 7) — verified by the guard script/hook, not by review alone.
