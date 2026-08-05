# Task 52 Plan: integration test for `prepareTasks` against a real repository

## Why (one paragraph, so the plan below doesn't need re-justifying line by line)

Task 48 wired the real repository manifest into `groupTasksByFileOverlap` and it broke
immediately against a real checkout, because the unit tests only ever exercised
`repositoryGraph.ts` against hand-written fixtures. Three defects survived 1027 green
tests: (1) `repositoryDiscovery.ts` stores `checkoutPath` as an absolute path but
`repositoryGraph.ts` compares it against root-relative task paths, so nothing ever
matches; (2) `originUrl` is copied from a (usually absent) prior record and the git
remote is never actually read, so identity resolution sees an empty/unparseable URL;
(3) the root occurrence's `occurrenceId` is `""`. The user has already decided defect
(1)'s fix: keep `checkoutPath` absolute, and make the *graph matchers* relativize
against the root occurrence's `checkoutPath` — do not revisit that. This plan adds a
real-git-repository integration test that proves all three are fixed, and fixes them.

## Scope guardrail

Do not re-wire task 48 (`groupTasksByFileOverlap` production callers) in this task.
This task only fixes `repositoryDiscovery.ts` + `repositoryGraph.ts` and proves the fix
with an integration test. Task 48 gets re-attempted separately, after this lands.

## Step 0 — Learn the unseen surface area before writing anything

This plan was written from a brief that inlined `repositoryDiscovery.ts`,
`repositoryGraph.ts`, and `repositoryGraph.test.ts` in full, but does **not** show:
`scripts/repositoryManifest.ts`, `scripts/gitlinkReader.ts`,
`scripts/baseBranchResolution.ts`, `scripts/resolutionRequests.ts`, or wherever
`bootstrapRepositoryManifest`, `groupTasksByFileOverlap`, and `buildWorkflowArguments`
are exported from (most likely a `scripts/prepareTasks*.ts` module, given task 48's
title). Before writing the integration test, run:

```
rg -n "export function (bootstrapRepositoryManifest|groupTasksByFileOverlap|buildWorkflowArguments)" scripts/
rg -n "export (type|function)" scripts/repositoryManifest.ts scripts/resolutionRequests.ts
rg -n "getOwningOccurrence|getPathWithinRepository" scripts/ tests/
```

Read just enough of each hit to know: the exact parameter/return shapes of the three
`prepareTasks` functions, the `ResolutionManifest` shape (an empty/starting value is
needed to call `discoverRepositoryTree`/`bootstrapRepositoryManifest`), and every
existing call site of `getOwningOccurrence` / `getPathWithinRepository` — the latter's
signature changes in Step 2, so every caller found here must be updated in that step.

## Step 1 — Reconcile the coordinate-system conflict (decide production wins)

`tests/repositoryGraph.test.ts`'s fixture treats task paths as relative to the root
occurrence's **parent** directory (root `checkoutPath: "jfred"`, task path
`"jfred/external/tmux_lib/src/foo.ts"`). Production paths are relative to the repo root
itself (root `checkoutPath` = the real absolute `rootPath`, task path
`"scripts/foo.ts"`, no root-directory prefix). Production is the convention that has to
be correct, so the fixture is what gives.

In `tests/repositoryGraph.test.ts`, change the two task-path literals from
`"jfred/external/tmux_lib/src/foo.ts"` to `"external/tmux_lib/src/foo.ts"` (drop the
root occurrence's own directory name — it's implicit, not part of the root-relative
path) in:
- `test_getOwningOccurrenceResolvesToTheDeepestMatchingRepositoryNotItsAncestor`
- `test_getPathWithinRepositoryIsRelativeToTheOwningOccurrenceRoot`

Leave every occurrence's `checkoutPath` fixture value unchanged (`"jfred"`,
`"jfred/external/tmux_lib"`, etc.) — those stand in for real absolute paths, which is
what `join(rootPath, relativePath)` always produces in production; only the meaning of
the *input* path argument was wrong.

This step alone will not compile/pass yet — Step 2 changes `getPathWithinRepository`'s
signature to take the manifest, which this file's calls also need updated for. Land
Steps 1 and 2 together and run the file once at the end of Step 2.

## Step 2 — Fix `scripts/repositoryGraph.ts`: relativize checkoutPath against root

The file already has an unused helper for this (`checkoutPathFromRoot`, currently only
referenced from a comment). Wire it into both matching functions instead of comparing
raw (absolute) `checkoutPath` against a root-relative input path.

Replace `getOwningOccurrence`:

```ts
export function getOwningOccurrence(
    rootRelativePath: string,
    manifest: RepositoryManifest,
): RepositoryOccurrence | null {
    const root = findRootOccurrence(manifest);
    if (!root) return null;

    let owner = root;
    let descended = true;
    while (descended) {
        descended = false;
        for (const child of getChildren(owner, manifest)) {
            if (isWithinCheckout(rootRelativePath, checkoutPathFromRoot(child, root))) {
                owner = child;
                descended = true;
                break;
            }
        }
    }
    return owner;
}
```

This drops the old initial `.find(occurrence => occurrence.parentOccurrenceId === null
&& isWithinCheckout(...))` — that was the exact line comparing a root-relative path
against an absolute `checkoutPath`, which never matches. The root always owns
everything by definition, so start there directly and only relativize while descending
into children.

Replace `getPathWithinRepository` (now takes the manifest, needed to find root for
relativizing):

```ts
export function getPathWithinRepository(
    rootRelativePath: string,
    owningOccurrence: RepositoryOccurrence,
    manifest: RepositoryManifest,
): string {
    const root = findRootOccurrence(manifest);
    const checkoutPath = root ? checkoutPathFromRoot(owningOccurrence, root) : owningOccurrence.checkoutPath;
    if (checkoutPath === "") return rootRelativePath;
    if (rootRelativePath === checkoutPath) return "";
    return rootRelativePath.slice(checkoutPath.length + 1);
}
```

`isWithinCheckout` itself is unchanged — it already compared two root-relative strings
correctly; the bug was always in what got passed to it.

Update every call site found in Step 0's grep to pass `manifest` as the third argument.
Update the two calls in `tests/repositoryGraph.test.ts` (Step 1) the same way.

Verify: `bun test tests/repositoryGraph.test.ts` passes.

## Step 3 — Fix `scripts/repositoryDiscovery.ts`: real originUrl, non-empty root occurrenceId

Two one-line fixes plus one small helper, in `discoverOccurrenceAndDescendants`:

**occurrenceId** — the root call passes `relativePath: ""`, which becomes the
occurrenceId verbatim. Give the root a non-empty sentinel; nested occurrences keep
using their relative path (already unique, unaffected):

```ts
const occurrenceId = relativePath === "" ? "root" : relativePath;
```

This is safe: `occurrenceId` is never compared against `checkoutPath`/path-matching
logic (Step 2 uses `checkoutPath`, not `occurrenceId`). Collision is only possible if a
gitlink is literally named `root` at the repository root (its relative path would then
also be `"root"`); accepted as a negligible edge case rather than adding a reserved-word
check for it.

**originUrl** — currently `existing?.originUrl ?? ""`, which never reads git and
defaults to empty. Read it for real, every call (cheap, and caching risks exactly the
staleness this defect already caused — don't reintroduce that). Add near
`readRootBranchAndOid`:

```ts
function readOriginUrl(checkoutPath: string): string {
    try {
        return execFileSync("git", ["-C", checkoutPath, "remote", "get-url", "origin"], {
            encoding: "utf8",
        }).trim();
    } catch {
        throw new Error(`repository at "${checkoutPath}" has no "origin" remote configured`);
    }
}
```

And change the occurrence literal's `originUrl` field to:

```ts
originUrl: readOriginUrl(checkoutPath),
```

Do **not** touch the `checkoutPath` assignment (`join(rootPath, relativePath)`) — the
decision already made is that it stays absolute; Step 2 is where the fix for that
lives.

Note for the integration test in Step 4: `git submodule add <path> <dir>` clones the
submodule and sets its `origin` remote to `<path>` automatically, so `readOriginUrl`
works for submodule occurrences without any extra setup. The root repo needs an
explicit `git remote add origin <url>` in the test's setup, since `git init` doesn't
add one.

Verify: nothing else references `.originUrl ?? ""` or an empty-string occurrenceId
assumption — re-check the Step 0 grep results for any such assumption before moving on.

## Step 4 — Write `tests/prepareTasksIntegration.test.ts` (new file)

Follow the existing style in `tests/repositoryGraph.test.ts` (`node:test` +
`node:assert/strict`, module-scope shared fixture built once). Split into one `test_`
per behavior per the TDD granularity guideline, all sharing one real-repository setup
built once at module load, with a plain-English step comment per assertion.

**Shared setup** (module scope, built once, before the `test()` calls):

1. `mkdtempSync(join(tmpdir(), "prepareTasksIntegration-"))` for the root repo.
2. Root repo: `git init -q -b main`, `git config user.email`, `git config user.name`
   (needed to commit), create `scripts/foo.ts`, `git add`, `git commit -q`, then
   `git remote add origin https://example.com/root.git`.
3. A second temp dir for the submodule's source content: `git init -q -b main`, same
   user config, create `src/bar.ts`, `git add`, `git commit -q`. (No manual `origin`
   remote here — `git submodule add` sets it.)
4. From the root repo: `git -c protocol.file.allow=always submodule add -q
   <submoduleSourcePath> external/sub`, then `git commit -q -m "add submodule"`.
   The `protocol.file.allow=always` flag is required — git 2.38+ refuses `file://`-style
   submodule URLs (a local temp path) by default and throws `transport 'file' not
   allowed` without it.
5. Call `bootstrapRepositoryManifest` (or `discoverRepositoryTree` directly, if that's
   what it turns out to wrap per Step 0) against the root path with a fresh/empty
   resolution manifest. Both commits are the sole tip of their respective `main`
   branches, so `resolveBaseBranchCandidates` resolves to `"single"` for the submodule
   and the root bypasses branch resolution entirely (`parentOccurrenceId === null`
   branch reads the current branch directly) — assert `status === "resolved"`, no
   `needsResolution` handling needed.
6. `after(() => rmSync(rootTempDir, { recursive: true, force: true }))` to clean up.

**Tests** (each a single `test_` function, reusing the shared setup's resulting
manifest/rootPath):

- `test_ownershipResolvesForARootFilePath` — `getOwningOccurrence("scripts/foo.ts",
  manifest)` returns the root occurrence (assert on `parentOccurrenceId === null` or
  equivalent identity, not on `checkoutPath` literal since that's a real absolute temp
  path).
- `test_ownershipResolvesForASubmoduleFilePath` — `getOwningOccurrence("external/sub/
  src/bar.ts", manifest)` returns the submodule occurrence (`parentOccurrenceId` equals
  the root's occurrenceId).
- `test_everyOccurrenceHasANonEmptyOriginUrl` — iterate `manifest.occurrences`, assert
  `originUrl !== ""` for all (this is what catches defect 2 regressing).
- `test_everyOccurrenceHasANonEmptyOccurrenceId` — same iteration, assert
  `occurrenceId !== ""` for all (catches defect 3 regressing).
- `test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing` — build two minimal
  real task objects (per whatever shape `groupTasksByFileOverlap` takes, per Step 0),
  one touching `scripts/foo.ts` and one touching `external/sub/src/bar.ts`, call
  `groupTasksByFileOverlap` (and `buildWorkflowArguments` on its result, since the brief
  asks for both to run without throwing) and assert it returns without throwing and
  produces at least one group.

RED first: write this file against the *unfixed* `repositoryDiscovery.ts`/
`repositoryGraph.ts` and confirm it fails with the same symptom the brief describes
(`no occurrence owns path ...` / unparseable origin URL / empty occurrenceId) before
applying Steps 2–3. Then apply Steps 2–3 and confirm GREEN. (Steps are listed 1-2-3-4
above for readability, but the actual implementation order is: write this test file
first against unfixed source to see it fail for the right reasons, then do Steps 1–3,
then re-run.)

## Step 5 — Full verification

```
bun test tests/repositoryGraph.test.ts
bun test tests/prepareTasksIntegration.test.ts
bun test
```

The last command must stay green across the whole suite — the `getPathWithinRepository`
signature change (Step 2) is the one change with call-site blast radius outside the
files this task directly edits, so this is the check that nothing downstream (task 48's
reverted code excluded, since it's not being re-wired here) was silently relying on the
old two-argument signature or the old absolute-vs-relative matching.

## Files touched

- `scripts/repositoryDiscovery.ts` — `readOriginUrl` helper, occurrenceId fix, originUrl fix.
- `scripts/repositoryGraph.ts` — `getOwningOccurrence` / `getPathWithinRepository` relativize against root.
- `tests/repositoryGraph.test.ts` — fixture task-path literals + `getPathWithinRepository` call sites, reconciled to the production coordinate convention.
- `tests/prepareTasksIntegration.test.ts` — new file.
- Any other caller of `getOwningOccurrence`/`getPathWithinRepository` found by the Step 0 grep — signature-only update, no behavior change intended there.
