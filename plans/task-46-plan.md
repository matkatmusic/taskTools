# Task 46 Plan: Route repositoryBranches through graph discovery, guard first

## Behavior, in plain English

`scripts/repositoryBranches.ts` currently discovers "which repositories exist"
(parent + submodules) and "what branch is each one on" by shelling out to git
directly (`git submodule foreach`, `git branch --show-current`) for every
repository, one at a time. Task 35's cutover wants that discovery to instead
come from the single occurrence graph that `scripts/manifestBootstrap.ts`
already builds (task 44 made that graph read-only).

This task is step 1 of that cutover: make `repositoryBranches.ts` read its
list of repositories and their source branches from the graph, while keeping
one safety property completely intact — a detached submodule is refused
before anything trusts the graph's own branch resolution, because the
graph resolves "the branch for this repository" by matching a local branch's
tip commit to the recorded gitlink OID, and a detached checkout does not move
that branch's tip. So the graph would confidently name a branch for a
detached repository that is, in fact, not what's checked out. The existing
`git branch --show-current`-based detached check (empty string = detached)
is immune to that trap and must keep running first, in its current position,
with its current per-path error naming.

Objects/actions in play: the occurrence graph (built by manifestBootstrap),
an occurrence's recorded gitlink OID, an occurrence's resolved base branch,
the `needsResolution` refusal a bootstrap call can return instead of a graph,
the detached-HEAD guard (unchanged), `RepositorySource` records, and branch
creation (`createBranchInEveryRepository`, which must not be exercised by
anything in this task — no discovery path may create or check out a branch).

## Step 0 — Bind the actual graph API (implementer, before writing code)

This plan was written from the brief only; the exact shape of
`scripts/manifestBootstrap.ts`'s exports was intentionally not read while
planning. Before touching `repositoryBranches.ts`, read
`scripts/manifestBootstrap.ts` (and, if present, `tests/manifestBootstrap.test.ts`
for a canonical `needsResolution` fixture — task 44 almost certainly already
built one; reuse or mirror it rather than inventing a new trigger) and pin
down:

1. The name of the function that returns the graph (or a `needsResolution`
   refusal) for a given `repoRoot`.
2. The discriminant shape of that result — how a caller tells "got a graph"
   apart from "needs resolution" (a boolean flag, a tagged union, a thrown
   error — whichever it is).
3. Per occurrence in the graph: the field holding its path (must match the
   `displaypath`-style relative path `submodulePaths` returns today, e.g.
   `"vendor"`, `"vendor/nested"`), the field holding its resolved base branch
   name, and whether the parent repository itself appears as an occurrence
   or is out of scope for the graph (submodules have a gitlink OID to match
   against; the top-level repo does not).
4. Whether building the graph at all can itself throw/return `needsResolution`
   for a repository the caller wasn't specifically asking about — i.e.,
   whether just listing occurrence paths already carries refusal risk, or
   only per-occurrence branch resolution does.

Everything below refers to these as `loadRepositoryGraph`,
`GraphResult`/`needsResolution`, `occurrence.path`, `occurrence.baseBranch` —
substitute the real names found in Step 0.

## Step 1 — `submodulePaths`: replace the hand-rolled walk

Replace the `execFileSync(["submodule", "--quiet", "foreach", ...])` body
with a call into `loadRepositoryGraph(repoRoot)`, mapping the graph's
occurrences to their relative paths (excluding the parent, if the parent is
modeled as an occurrence at all). If the call signals `needsResolution`,
throw a plain `Error` describing that resolution is required — do not let a
raw refusal object or an `undefined`-property access propagate as the error.
This satisfies "instead of walking submodule paths by hand" directly: this
function's git-shelling implementation is what the brief is describing.

Keep the function's signature and return type (`string[]`) unchanged — the
existing test `test_submodulePathsListsTheParentRepositorysSubmodules` calls
it directly and must keep passing unmodified.

## Step 2 — `collectRepositorySources`: guard first, discovery second

Keep this ordering, and do not collapse it into fewer passes even though
that would touch each repository fewer times — the ordering is the safety
property this task exists to preserve:

1. Build `paths = ["", ...submodulePaths(repoRoot)]` — this is topology only
   (which repositories exist), sourced from the graph via Step 1's
   `submodulePaths`. If Step 0 found that even building the graph's occurrence
   list can throw `needsResolution` for a repository, that error surfaces
   here naturally through `submodulePaths` — no separate handling needed.
2. Run the existing detached-HEAD loop completely unchanged: for each path,
   `currentBranchName(fullPath)` (still a direct `git branch --show-current`
   call, never routed through the graph), collect empty results into
   `detachedPaths`, and throw the same message
   (`` `these repositories are on a detached HEAD and cannot be
   task-branched: ${detachedPaths.join(", ")}` ``) naming `"(parent)"` or the
   submodule path exactly as today. This loop must run to completion (i.e.
   check every path, not stop at the first detached one) before anything
   from Step 3 runs, matching the current code's behavior.
3. Only once no path is detached, resolve each path's `sourceBranch`:
   - `path === ""`: keep using `currentBranchName(repoRoot)` (already known
     from step 2's pass — reuse that value rather than calling git a second
     time). The parent has no gitlink OID to match against, so it has
     nothing for graph discovery to resolve.
   - every other path: use the occurrence's resolved base branch from the
     graph loaded in step 1 (`occurrence.baseBranch` per Step 0's naming),
     not a fresh `currentBranchName` call. This is the actual "discovery"
     the brief is routing through the graph — the detached guard already
     ran and ruled out the one case (detached HEAD) where that resolution
     would be wrong.
   - If Step 0 found the graph is only obtainable in one shot (no separate
     per-occurrence branch lookup), fetch it once at the top of this
     function and reuse it for both step 1's path list and step 3's branch
     values, rather than loading it twice.

If a `needsResolution` refusal surfaces at this stage (rather than at the
`submodulePaths` call), wrap it the same way: throw a plain `Error`, never a
raw refusal object.

## Step 3 — `createBranchInEveryRepository`: confirm, don't rewrite blind

This function only ever operates on a caller-supplied `paths: string[]` and
already resolves each one with `join(repoRoot, path)`. It doesn't discover
anything itself, so it needs no behavior change unless Step 0 finds the
graph's path values use a different format than plain relative displaypaths
(e.g. absolute paths, or a structured occurrence id instead of a string).
If the formats already match plain relative paths, leave this function's
body untouched — don't rewire something that isn't broken. If they don't
match, resolve each path through the same helper Step 1/2 use to turn a
graph path into a filesystem location, so all three functions agree on one
resolution rule.

Its own tests (`test_createBranchInEveryRepositoryChecksOutTheBranchIn...`,
`test_createBranchInEveryRepositoryIsIdempotent...`) call it with literal
`["", "vendor"]` and must keep passing unmodified regardless.

## Step 4 — Tests (add only; the five existing tests are unmodified)

Follow red-green: write each test below failing first, then write the
minimum code in Steps 1–3 to make it pass, one test at a time.

`test_collectRepositorySourcesCreatesNoBranchAndLeavesEveryWorkingDirectoryBranchUnchanged`
in `tests/repositoryBranches.test.ts`:
- Steps: build a temp repo with a local submodule (existing
  `makeTempRepoWithLocalSubmodule` helper).
- Record `currentBranchName(repoRoot)` and `currentBranchName(join(repoRoot, "vendor"))`
  before calling `collectRepositorySources`.
- Call `collectRepositorySources(repoRoot)`.
- Assert both branch names are identical before and after.
- Assert `git branch --list` in each repository has the same set of branch
  names before and after (proves no branch was created, not just that the
  checked-out one didn't move).

`test_collectRepositorySourcesSurfacesABootstrapRefusalAsACleanError`
in `tests/repositoryBranches.test.ts`:
- Steps: build whatever fixture Step 0 identified as triggering
  `needsResolution` from `manifestBootstrap` (mirror its own test fixture if
  one exists).
- Call `collectRepositorySources(repoRoot)`.
- Assert it throws, that the thrown value is an `Error` instance (not a
  crash from touching a property on `undefined`, not the raw refusal object),
  and that `.message` is a non-empty, human-readable string.

Both tests are additions to the existing five in
`tests/repositoryBranches.test.ts`; none of the current five change.

## Non-goals

- No change to `createBranchInEveryRepository`'s `-B` (reset-on-reuse)
  semantics or its own tests.
- No change to the detached-HEAD error message text or which paths get
  named — only where its inputs (`paths`) now come from.
- No performance work beyond avoiding an obviously duplicate graph fetch
  inside `collectRepositorySources` (Step 2's last bullet) — don't add
  caching beyond that single reuse.

## Files touched

- `scripts/repositoryBranches.ts` (implementation)
- `tests/repositoryBranches.test.ts` (two new tests appended; existing five
  untouched)

## Verification

- `node --test tests/repositoryBranches.test.ts` — all five existing tests
  plus the two new ones pass.
- Manually confirm (by reading the diff) that the detached-HEAD loop in
  `collectRepositorySources` still runs directly against
  `currentBranchName`/git and executes in full before any graph-resolved
  `sourceBranch` value is read.
