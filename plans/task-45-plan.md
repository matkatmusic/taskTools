# Task 45 Plan: `scripts/manifestBootstrap.ts`

## Goal (from brief)
Nothing in production can turn a bare `repoRoot` into a `RepositoryManifest`/occurrence
graph. Add one entry point that does this in-memory, non-interactively, and returns
either a resolved occurrence graph or a named refusal — never a disk write, never a
git checkout/branch, never a prompt.

## Step 0 — Discovery (do this before writing any code)
This plan was written from the brief only; the exact shapes below must be confirmed
against the real source before implementing. Locate and read, in this order:

1. `rg -n "discoverRepositoryTree" scripts/` — find its file, its full signature
   (`rootPath`, `manifest` param types, return type), and what it mutates vs. returns.
2. `rg -n "DiscoveryManifest|ResolutionManifest|REPOSITORY_MANIFEST_VERSION|ResolutionRequest" scripts/`
   — find where these types/constants are defined (likely a `scripts/repositoryManifest*.ts`
   or `scripts/discoveryManifest*.ts` file) and their exact field names.
3. `rg -n "readRepositoryManifest|writeRepositoryManifest" scripts/` — confirm these
   are unused outside their own file (brief already asserts this) and note their
   manifest-shape assumptions, since `manifestBootstrap.ts` must build a manifest
   those two functions could later read/write.
4. `rg -n "buildCanonicalTaskGroups|setUpOperationBranches" scripts/` — confirm these
   are NOT called from this task (brief lists them only as other blocked consumers;
   task 45 only wires up `discoverRepositoryTree`). Do not call them.
5. Find any existing test file that hand-builds a `DiscoveryManifest`/`ResolutionManifest`
   (e.g. a `discoverRepositoryTree.test.ts` or similar) — copy its fixture-repo setup
   helpers (how it creates a temp git repo with a submodule/gitlink) instead of writing
   new ones. Reuse, don't reinvent.
6. Confirm how an unresolved gitlink surfaces: does `discoverRepositoryTree` push
   entries onto `manifest.resolutionManifest` (or similarly named field) as
   `ResolutionRequest` objects with a `reason`, or does it return something separately?
   The refusal object this task builds is derived from whatever that field ends up
   holding after the call.

If any of the above doesn't match what the brief describes (e.g. `discoverRepositoryTree`
turns out to require more than `rootPath` + `manifest`, or resolution requests live
somewhere other than the manifest), stop and treat the brief's description as the
contract to satisfy — adapt the wiring, not the two documented behaviors (in-memory
only, refuse-with-reasons).

## Step 1 — Define the module's contract
Create `scripts/manifestBootstrap.ts` exporting one function:

```ts
export type ManifestBootstrapRefusal = {
    refused: true;
    requests: Array<{ request: ResolutionRequest; reason: string }>;
};

export type ManifestBootstrapResult =
    | { refused: false; occurrenceGraph: /* the resolved graph type discoverRepositoryTree produces */ }
    | ManifestBootstrapRefusal;

export function bootstrapRepositoryManifest(repoRoot: string): ManifestBootstrapResult {
    // see Step 3 below for the four-step body
}
```

Naming: match whatever the real types are called (found in Step 0) rather than the
placeholder names above — the placeholders exist only to describe shape, per the
coding-standards naming rules (accurate, descriptive, no abbreviations).

Do NOT:
- read or write any file on disk (no calls to `readRepositoryManifest` /
  `writeRepositoryManifest`, no `fs.write*`)
- run any `git checkout` or `git branch` — this function only *discovers*, it never
  calls `setUpOperationBranches` or any git-mutating helper
- prompt interactively (no `readline`, no inquirer-style prompt) — a request that
  can't be auto-resolved goes straight into the refusal, it is never asked about

## Step 2 — Tests first (`tests/manifestBootstrap.test.ts`)
Follow strict red-green TDD: write each test below failing first, then write the
minimum code in `scripts/manifestBootstrap.ts` to turn it green, one test at a time,
in this order (each is independently gradable — don't jump ahead).

### test_bootstrapReturnsResolvedGraphForRepoWithNoSubmodules
Scenario: a plain repo (no submodules) bootstraps straight to a resolved graph.
- create a temp git repo with no submodules (reuse the fixture helper found in Step 0.5)
- call `bootstrapRepositoryManifest(repoRoot)`
- assert `result.refused === false`
- assert the occurrence graph holds exactly one occurrence, for the root repo

### test_bootstrapResolvesSubmoduleAtRecordedGitlinkOid
Scenario: a repo whose submodule sits at its recorded gitlink OID resolves both occurrences.
- create a temp git repo with one submodule, checked out at the exact OID its parent gitlink records
- call `bootstrapRepositoryManifest(repoRoot)`
- assert `result.refused === false`
- assert the occurrence graph holds two occurrences: root + submodule

### test_bootstrapRefusesWithNamedReasonForUnresolvableGitlink
Scenario: an unresolvable gitlink produces a non-interactive refusal naming every request and its reason.
- create a temp git repo with a submodule gitlink that cannot be resolved (submodule dir absent, or checked out at a different OID than the gitlink records)
- call `bootstrapRepositoryManifest(repoRoot)`
- assert `result.refused === true`
- assert `result.requests` has one entry per unresolved `ResolutionRequest`
- assert each entry carries a non-empty reason string

### test_bootstrapPerformsNoGitCheckoutOrBranchCreation
Scenario: bootstrap never mutates the repo, on either the resolved or refusal path.
- for BOTH a resolvable repo and an unresolvable-gitlink repo: record `git rev-parse HEAD` and `git branch --list` before the call
- call `bootstrapRepositoryManifest(repoRoot)`
- assert HEAD is unchanged and the branch list is unchanged after the call

Granularity check per TDD guide: these four are already single-behavior tests (one
observable outcome each) — do not further split, do not merge them.

## Step 3 — Implement
Only after each test above is red, write the minimum body of
`bootstrapRepositoryManifest` to go green, in the same order as the tests. Expected
shape (adjust names per Step 0 findings):

1. Construct the empty `DiscoveryManifest` literal (`version: REPOSITORY_MANIFEST_VERSION`,
   empty `resolutionManifest`, empty occurrence collection — match whatever
   `discoverRepositoryTree` expects as its starting/mutable input).
2. Call `discoverRepositoryTree(repoRoot, manifest)`.
3. Read back the resolution requests left on the manifest. If none, return
   `{ refused: false, occurrenceGraph: <manifest's occurrence graph field> }`.
4. If any remain, map each to `{ request, reason }` and return
   `{ refused: true, requests }`.

Keep the function to this single responsibility — no persistence, no branch setup,
no prompt. If `readRepositoryManifest`/`writeRepositoryManifest` wiring is wanted by a
future caller, that is a separate task; this task explicitly keeps the manifest
in-memory only (per brief).

## Step 4 — Verify
- Run the full test file: `bun test tests/manifestBootstrap.test.ts`
- Run the existing suite to confirm nothing else broke: `bun test`
- Confirm no new files were written to disk by the function under test (the fourth
  test already covers no-checkout/no-branch; also eyeball that no manifest JSON file
  appears in the temp repo fixtures after a run)
- Re-read `scripts/manifestBootstrap.ts` once complete: confirm no interactive prompt
  code path exists and no call to any git-mutating helper is present anywhere in the
  file

## Out of scope (explicitly, per brief — do not add)
- Persisting the manifest to disk (`readRepositoryManifest`/`writeRepositoryManifest`
  wiring) — brief says keep in memory until a caller needs persistence; no caller
  needs it yet, so don't build it speculatively
- Calling `buildCanonicalTaskGroups` or `setUpOperationBranches` — brief lists them as
  other blocked consumers of the graph, not part of this task
- Any interactive resolution UI/prompt for `ResolutionRequest`s — refusal is the whole
  non-interactive story for this task
