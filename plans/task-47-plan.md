# Task 47 Plan: Swap taskGroups grouping onto canonicalTaskGroups

## Why
`scripts/taskGroups.ts` currently does its own union-find file-overlap grouping
(`groupTasksByFileOverlap`). `scripts/canonicalTaskGroups.ts` already has a
`buildCanonicalTaskGroups(manifest, tasks)` that is meant to replace it, but it
needs a `RepositoryManifest` — something `groupTasksByFileOverlap` never took.
Task 45 built the manifest bootstrap and task 46 wired it into callers; this
task's only job is to stop computing groups twice and route everything through
`buildCanonicalTaskGroups`, without changing what a flat single-repository run
produces.

This task depends on 45 and 46 having landed. Confirm that before starting —
if `scripts/canonicalTaskGroups.ts` doesn't exist yet, or nothing in the repo
constructs a `RepositoryManifest`, stop and flag it rather than guessing at
their shape.

## Step 0 — investigate (do this before writing any code)
1. Read `scripts/canonicalTaskGroups.ts` and `tests/canonicalTaskGroups.test.ts`.
   Note:
   - `buildCanonicalTaskGroups`'s exact parameter order/types.
   - Its return type — compare field-for-field against `taskGroups.ts`'s
     `TaskGroup` (`groupId`, `taskNumbers`, `filePaths`, `scope`). If it's
     identical, no adapter mapping is needed. If it carries extra fields
     (e.g. a repository identifier), a small mapping step is needed.
   - How the test file constructs a manifest for the flat/single-repo case —
     reuse that construction verbatim rather than inventing a new one
     (ladder rung 2: reuse before writing).
2. `rg -l "groupTasksByFileOverlap"` across the repo (excluding
   `scripts/taskGroups.ts` and `tests/taskGroups.test.ts` themselves) to find
   every importer. For each hit, note the file and whether it already has a
   `RepositoryManifest` in scope from task 46's wiring, or only has
   `TaskRecord[]`.
3. `rg "RepositoryManifest"` to find the type and whatever task 45 exposed for
   building one (a bootstrap/constructor function). You need this for any
   caller in step 2 that has no manifest of its own.

## Step 1 — migrate callers that already have a manifest
For every importer from Step 0.2 that already has a `RepositoryManifest` in
scope: change its call site to call `buildCanonicalTaskGroups(manifest, tasks)`
directly and drop its import of `groupTasksByFileOverlap`.

For every importer that has no manifest available and plumbing one through is
out of scope for this task: leave it calling `groupTasksByFileOverlap` — Step 2
keeps that export alive as an adapter.

Write down, in the implementation notes, which callers were migrated directly
and which still go through the adapter, and why. (The brief explicitly asks
for this to be stated.)

## Step 2 — reimplement `groupTasksByFileOverlap` as a thin adapter
Delete the union-find body (`findRoot`, `union`, and the grouping logic) from
`scripts/taskGroups.ts`. Replace `groupTasksByFileOverlap` with a thin wrapper
that builds a flat single-repo manifest (via task 45's constructor, found in
Step 0.3 — do not write a new one) and delegates:

```ts
export function groupTasksByFileOverlap(tasks: TaskRecord[]): TaskGroup[] {
    const manifest = buildSingleRepositoryManifest(tasks); // name from Step 0.3
    return buildCanonicalTaskGroups(manifest, tasks); // add a map() here only if the return shape differs (see Step 0.1)
}
```

Keep `declaredFiles`, `TaskGroup`, and `TaskGroupScope` exported unchanged —
they're the public contract other files rely on. Only delete what the
union-find implementation owned.

If Step 1 migrated every single caller directly (no caller left needing the
old signature), skip the adapter entirely and delete
`groupTasksByFileOverlap` — don't keep dead code around "for later."

## Step 3 — tests
Keep this granular; each assertion below is its own check, not folded into one
big test.

1. `tests/canonicalTaskGroups.test.ts` should need no changes — confirm it
   still passes as-is.
2. `tests/taskGroups.test.ts`: keep every existing assertion (the grouping
   results) unchanged. The five `test_groupTasksByFileOverlap*` cases must
   still prove the same groupings — that's the "same as before for the flat
   single-repository case" requirement from the brief.
   - If `groupTasksByFileOverlap`'s signature didn't change (Step 2's wrapper
     builds the manifest internally), the test file needs no edits at all —
     confirm that's true before touching it.
   - If the adapter was deleted in Step 2 (every caller migrated), delete
     `tests/taskGroups.test.ts` and move its five behavioral assertions into
     `tests/canonicalTaskGroups.test.ts` as calls to
     `buildCanonicalTaskGroups` with a flat single-repo manifest, one test at
     a time, keeping the same `test_` names and step comments.
3. Run `bun test tests/taskGroups.test.ts tests/canonicalTaskGroups.test.ts`,
   then the full test run (`bun test` / `node --test tests/`), to confirm
   nothing else broke.

## Adapter decision (fill in during implementation)
State explicitly, once Step 0–1 are done: which callers were migrated to call
`buildCanonicalTaskGroups` directly, which (if any) still route through the
`groupTasksByFileOverlap` adapter, and whether the adapter was deleted
outright because no caller needed it.

## Skipped (ponytail)
- No new abstraction layer for "grouping strategies" — one function delegates
  to another, that's the whole task.
- Not touching manifest-bootstrap logic itself — that's tasks 45/46's territory.
- No caching/memoization for repeated grouping calls — nothing in the brief
  asks for it; add it later if a profiler says so.
