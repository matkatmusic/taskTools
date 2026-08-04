# Task 22 Plan: canonicalTaskGroups.ts

## Why (brief summary)

Phase 3 of the repository-discovery redesign. `scripts/taskGroups.ts` groups
tasks by literal declared file-path overlap. That's wrong once occurrence
paths and ancestor gitlinks exist: two tasks can name the same logical file
through two different occurrence paths and `taskGroups.ts` would put them in
parallel groups, racing on the same file. `scripts/ownershipKeys.ts` (built in
an earlier phase) already resolves a raw path to its canonical
ownership/effect key(s), folding in ancestor-gitlink expansion. This task
builds a second, parallel grouping module that unions on those canonical keys
instead of raw path strings. It must not touch `taskGroups.ts` or
`prepareTasks.ts` — Phase 4 does the production cutover by swapping the import.

## Before writing any code

The planning agent did not read source files (scope-restricted to the brief
only). The implementing agent MUST start by reading, in full:

1. `scripts/ownershipKeys.ts` — find the exact exported function(s) that turn
   a raw declared path into its canonical key(s). Note whether it returns one
   key or a set (ancestor-gitlink expansion implies a path can canonicalize to
   more than one effect key — union on ANY shared key, not just the primary
   one).
2. `scripts/taskGroups.ts` — find:
   - the `Task` input type (or whatever it's actually called) and the shape
     of the file-list field on a task,
   - the grouping algorithm it uses today (almost certainly union-find over
     shared declared paths),
   - how it produces a `Group` output shape and how group IDs are derived —
     the new module must be stable/deterministic in the same spirit, so reuse
     the same ID-derivation approach if one exists (e.g. hash/sort of member
     task IDs). Do not import from `taskGroups.ts` if it doesn't already
     export what's needed — copy the minimal piece instead, since
     `taskGroups.ts` may not be modified.
3. Any exported types both files share, so `canonicalTaskGroups.ts` accepts
   the same task list shape callers already build for `taskGroups.ts` (this is
   what makes the Phase 4 cutover a one-line import swap instead of a
   call-site rewrite).

Do not skip this — the plan below describes the shape of the solution, not
the exact field/function names, because those weren't read during planning.

## Design (ladder-checked)

- Rung 2 (reuse): if `taskGroups.ts` already exports a generic grouping
  primitive (e.g. "union these tasks given a key-extractor per task"), import
  and reuse it, passing canonical keys instead of raw paths. Only fall to the
  next rung if no such reusable piece exists.
- Rung 6/7 (minimal new code): if nothing reusable exists, union-find over
  task IDs is ~20 lines — write it directly in `canonicalTaskGroups.ts`. Do
  not add a graph/union-find dependency for this.
- No new abstraction layer between `ownershipKeys.ts` and the union-find:
  call the canonicalization function directly per task, per declared file.

### Algorithm

For each task:
1. Compute `canonicalKeys(task)` = union of canonical ownership/effect keys
   for every declared file/path on that task, via the `ownershipKeys.ts`
   function found in step 1 above. Dedupe.
2. Union-find over tasks: for every canonical key, union all tasks that
   produced that key. (This is the mechanism that satisfies "overlap
   introduced only by ancestor-gitlink effects still unions" — the union
   happens on whatever keys `ownershipKeys.ts` returns, including any
   ancestor-expanded ones, not on the raw declared paths.)
3. Build final groups from the union-find's disjoint sets.
4. Sort for determinism:
   - task IDs within a group: sorted (numeric or lexicographic — match
     whatever ordering `taskGroups.ts` uses for its member list, found in step
     2).
   - groups themselves: sorted by their (sorted) member-task-ID list, or by
     whatever ordering scheme `taskGroups.ts` uses, so the same task set
     always produces the same array order.
5. Group IDs: derive deterministically from the sorted member-task-ID list
   (e.g. join + hash, or whatever scheme `taskGroups.ts` uses) — must NOT
   depend on Map/Set iteration order or on original input array order.

### Public export

Name the main export to mirror `taskGroups.ts`'s main export (same name
pattern, e.g. if `taskGroups.ts` exports `buildTaskGroups(tasks)`, export
`buildCanonicalTaskGroups(tasks)` with the same input/output shape). This is
what makes the Phase 4 cutover a single import-line change.

## TDD order (write tests first, red -> green)

Create `tests/canonicalTaskGroups.test.ts` before `scripts/canonicalTaskGroups.ts`
exists (or before it has real logic). Four cases, matching the brief's test
list exactly:

1. **Same logical file, different occurrence paths -> one group.**
   Two tasks each declare a file under a different occurrence root, but both
   paths canonicalize (per `ownershipKeys.ts`) to the same logical-file key.
   Assert both task IDs land in the same returned group.

2. **Disjoint files, same logical repo -> stay separate.**
   Two tasks declare files that canonicalize to different, non-overlapping
   keys, even though both files belong to the same repository/ownership root.
   Assert they land in two different groups. This is the case that would
   regress if grouping were done on ownership-root alone instead of the full
   canonical effect key — write the test to fail that simpler (wrong)
   implementation too.

3. **Overlap only via ancestor-gitlink effects -> still unions.**
   Two tasks declare raw paths that are disjoint as strings and would
   canonicalize to different *primary* keys, but whose ancestor-gitlink
   expansion (per `ownershipKeys.ts`) produces a shared effect key. Assert
   they land in the same group. This is the test that would fail if the
   implementation only unions on the first/primary canonical key per task
   instead of the full key set — union-find must run over ALL keys each task
   produces.

4. **Determinism.**
   Run the grouping function twice on the same task list (and once more on
   the same tasks in reversed input order). Assert: identical group IDs,
   identical group membership, identical array order across all three runs.

Use whatever fixture/mocking approach `tests/relatedTests.test.ts` or the
existing test suite already uses for constructing fake tasks and for
stubbing/using `ownershipKeys.ts` output (check during step 1's file reads) —
don't invent a new fixture style.

## Implementation order

1. Read `ownershipKeys.ts` + `taskGroups.ts` (see "Before writing any code").
2. Write `tests/canonicalTaskGroups.test.ts` with the four cases above,
   importing the not-yet-existing (or empty-stub) module — confirm red.
3. Implement `scripts/canonicalTaskGroups.ts`: canonical-key computation +
   union-find + deterministic sort/ID generation, per the Design section.
4. Run tests, get to green. Do not modify `scripts/taskGroups.ts` or
   `scripts/prepareTasks.ts` at any point.
5. Re-read the four tests against the final implementation and confirm each
   one would actually fail if its specific bug were reintroduced (e.g.
   temporarily union on ownership-root only, or on primary-key only) —
   this is the "does this test have a real ceiling" check, not extra scope.

## Explicitly out of scope for this task

- Wiring this module into `prepareTasks.ts` or anywhere else production code
  runs — that's the Phase 4 cutover task, named in the brief as a separate
  follow-up.
- Any change to `taskGroups.ts` — canonicalTaskGroups.ts is a fully separate,
  parallel module during this phase.
