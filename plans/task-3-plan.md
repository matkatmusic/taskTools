# Task 3 Plan: Non-destructive refusal of legacy flat repository manifests

Source brief: `plans/brief-3.md` (Phase 1 of the recursive repository-discovery redesign).

## Goal

Add a new, standalone module `scripts/legacyManifest.ts` that can look at a run
manifest and decide whether it was written by the old flat repository-path
model. If so, it must produce a **refusal result** — never an implicit
conversion, and never any action that deletes or mutates a worktree, branch,
or ref. Ship `tests/legacyManifest.test.ts` alongside it.

This is additive only: no existing file is modified, and nothing calls the
new module yet.

## Scope constraints (from the brief)

- New module only. No call sites wired into production code in this task.
- Detection must never implicitly convert a legacy manifest to the new shape.
- Refusal must never delete/remove a worktree directory, branch, or ref.
- The refusal result must carry: the detected version, the reason, and the
  exact recovery commands a human can run with *existing* tooling to finish
  or unwind that run.
- A current-version manifest must pass through untouched (not refused).

## Design

### What counts as "the current version"

`scripts/repositoryManifest.ts` is named in the brief as the source of truth
for the manifest version. Before writing `legacyManifest.ts`, read
`scripts/repositoryManifest.ts` to find:
- the exported constant/type that defines the current manifest version
  (e.g. something like `CURRENT_MANIFEST_VERSION` or a `version` field on a
  schema/type), and
- the manifest's on-disk shape (what fields exist today, in particular
  anything that records worktree paths and refs/branches, since the refusal
  fixture needs to assert those still exist afterward).

Do not guess the export name in the implementation; import whatever
`repositoryManifest.ts` actually exports as the version baseline. If no
explicit version constant exists yet in that file, that's a signal this task
may be blocked on Task order — flag it rather than inventing one, since brief
says "below the one defined in scripts/repositoryManifest.ts" implies that
constant already exists there.

### `scripts/legacyManifest.ts` — public surface

Keep it to one function plus the types it needs (ladder: no factory, no
class, no config object for values that don't vary):

```ts
export interface LegacyManifestRefusal {
  ok: false;
  detectedVersion: number | undefined; // undefined = versionless manifest
  reason: string;
  recoveryCommands: string[];
}

export interface LegacyManifestPass {
  ok: true;
}

export type LegacyManifestCheck = LegacyManifestRefusal | LegacyManifestPass;

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck;
```

Logic:
1. If `manifest` has no version field (or it's `undefined`/`null`) → refuse,
   `detectedVersion: undefined`, reason = "manifest predates version
   tracking (flat repository-path model)".
2. If `manifest.version < CURRENT_MANIFEST_VERSION` (imported from
   `repositoryManifest.ts`) → refuse, `detectedVersion: manifest.version`,
   reason = "manifest version {n} is older than current version {m}".
3. Otherwise → `{ ok: true }`. Do not mutate the input manifest in any case.

`recoveryCommands` should be a small, fixed list of strings describing
commands that already exist in the repo's tooling (e.g. whatever CLI/task
commands let a human inspect, finish, or clean up a run manually — check
`package.json` scripts and any existing CLI entry points referenced from
`repositoryManifest.ts` or its neighbors to name real commands rather than
invented ones). If no such commands are discoverable from the manifest
module's neighborhood, use accurate generic guidance (e.g. "inspect the
worktrees listed in this manifest manually before rerunning") rather than
fabricating a command that doesn't exist — do not fabricate a CLI surface
that isn't there.

Ladder check: this is ~30-40 lines, one function, two plain data types. No
class, no builder, no plugin system. Skip anything more.

## Files to change

1. `scripts/legacyManifest.ts` (new) — detection + refusal function and
   types described above.
2. `tests/legacyManifest.test.ts` (new) — see test plan below.

No other files touched. No import of `legacyManifest.ts` added anywhere
else (per "no call sites in production code yet").

## Test plan (`tests/legacyManifest.test.ts`)

Use whatever test runner/framework the rest of `tests/` already uses (check
one sibling test file's imports before writing this one, since the brief
gives no framework name).

Cases required by the brief:

1. **Versionless manifest is rejected** — a manifest object with no
   `version` field → `checkLegacyManifest` returns `ok: false` with
   `detectedVersion === undefined`.
2. **Older-version manifest is rejected** — a manifest with
   `version: CURRENT_MANIFEST_VERSION - 1` → `ok: false`,
   `detectedVersion` equals that older number.
3. **Rejection result names recovery commands** — assert
   `recoveryCommands.length > 0` and that the strings are non-empty/human
   readable (not just checking the array exists).
4. **Non-destructive fixture** — build a fixture manifest that records at
   least one worktree directory path and one ref/branch name (using real
   temp-dir + `git init`/`git worktree` setup if that's how existing repo
   fixtures do it — check an existing test for the repo's fixture pattern
   before inventing one). Run it through `checkLegacyManifest`, assert
   refusal, then assert the worktree directory still exists on disk and the
   ref/branch still exists in git. This proves the module took no action —
   it doesn't need to touch the filesystem/git at all, so the assertion is
   really "nothing was called that could delete these," which a pure
   function trivially satisfies; keep the fixture simple (create dir + git
   ref, call function, assert both still there) rather than mocking fs/git.
5. **Current-version manifest passes through** — a manifest with
   `version: CURRENT_MANIFEST_VERSION` → `checkLegacyManifest` returns
   `{ ok: true }`, and the input manifest object is unchanged (e.g.
   reference/deep-equal check against a clone taken before the call).

## Out of scope / explicitly not doing

- No wiring into `scripts/repositoryManifest.ts`, the finalizer, or any
  CLI/workflow entry point — the brief says no call sites yet.
- No actual deletion/cleanup logic for legacy runs — refusal only.
- No migration/conversion code path for legacy manifests.

## Open item to resolve at implementation time

The brief asserts `scripts/repositoryManifest.ts` already defines "the
version." Implementation must open that file first to confirm the exact
version constant/type name and the manifest shape (worktree/ref fields) the
test fixtures need to mimic. If that file does not actually define a
version concept, implementation should stop and flag the mismatch rather
than inventing a version scheme that duplicates/contradicts it.
