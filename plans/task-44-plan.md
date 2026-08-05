# Task 44 Plan: Make `discoverRepositoryTree` read-only

## Why (brief context, condensed)
`discoverRepositoryTree` currently mints its own `runId` and unconditionally calls
`setUpOperationBranches` (which does a real `git checkout`) on every occurrence it
resolves. That makes a read-only-sounding "discovery" function mutate the caller's
working directory. Task 35 needs to call graph discovery against the production
repo root before any worktree exists; if discovery still auto-branches, that swap
checks the user's real working directory onto a throwaway branch. Fix: discovery
returns the graph only; branch creation becomes an explicit, separate call the
caller makes with a `runId` it supplies.

`scripts/operationBranches.ts` already takes `runId` as a parameter and does not
mint one itself — it needs **no changes**. It's shown in the brief for context only.

## Step 0 — confirm no other caller depends on the auto-branch side effect
Before touching anything, grep the codebase for other call sites:
```
rg 'discoverRepositoryTree' --type ts
```
Every call site found besides `scripts/repositoryDiscovery.ts` itself and
`tests/repositoryDiscovery.test.ts` must be checked: does it rely on
`discoverRepositoryTree` having already created/checked-out operation branches
on the occurrences it returns? If so, that call site needs a follow-up call to
`setUpOperationBranches(graph, runId)` added, with a `runId` it generates itself
(e.g. via `randomUUID()` at the call site, mirroring what discovery used to do
internally). Task 35 has not landed yet, so there is likely no such caller today
outside the tests — but confirm this, don't assume it.

## Step 1 (RED) — update `tests/repositoryDiscovery.test.ts` to encode the new contract
Add the `operationBranches.ts` import at the top of the file, alongside the existing imports:
```ts
import { operationBranchName, setUpOperationBranches } from "../scripts/operationBranches.ts";
```

### 1a. Add three new small tests (place them near `test_discoverTreeWithUnresolvedRepository_stopsBeforeCreatingOperationBranches`, since they test the same class of behavior)

```ts
test("test_discoverRepositoryTree_createsNoNewBranches", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const checkoutPaths = [rootPath, join(rootPath, "child"), join(rootPath, "child", "grandchild")];
    const branchesBefore = checkoutPaths.map((path) => git(path, "branch", "--list"));

    const result = discoverRepositoryTree(rootPath, manifest);

    assert.equal(result.status, "resolved");
    checkoutPaths.forEach((path, index) => {
        assert.equal(git(path, "branch", "--list"), branchesBefore[index]);
    });
});

test("test_discoverRepositoryTree_leavesCurrentBranchUnchanged", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const checkoutPaths = [rootPath, join(rootPath, "child"), join(rootPath, "child", "grandchild")];
    const currentBranchesBefore = checkoutPaths.map((path) => git(path, "branch", "--show-current"));

    discoverRepositoryTree(rootPath, manifest);

    checkoutPaths.forEach((path, index) => {
        assert.equal(git(path, "branch", "--show-current"), currentBranchesBefore[index]);
    });
});

test("test_discoverRepositoryTree_leavesOperationBranchEmptyOnResolvedOccurrences", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    for (const occurrence of result.graph) {
        assert.equal(occurrence.operationBranch, "");
    }
});
```

These three fail against the current implementation (it creates branches and
checks them out during discovery), confirming RED.

### 1b. Modify `test_discoverUniqueDeeplyNestedTree_isReadyForDryRunIntegration`
This test currently asserts `occurrence.operationBranch !== ""` right after
discovery — that assumption no longer holds. Replace the branch-assertion block
with an explicit, caller-driven `setUpOperationBranches` call using a runId the
test supplies, proving that's how a caller gets branches now and that the runId
it passed is the one used in the branch name:

```ts
test("test_discoverUniqueDeeplyNestedTree_isReadyForDryRunIntegration", () => {
    const { rootPath } = makeJfredFullFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;

    assert.equal(result.graph.length, 5);

    const runId = "dry-run-integration";
    const branchedOccurrences = setUpOperationBranches(result.graph, runId);
    for (const occurrence of branchedOccurrences) {
        assert.equal(occurrence.operationBranch, operationBranchName(runId, occurrence));
    }

    const innerSubmodule = findOccurrence(result.graph, "jfred/jfredToolsPlugin/innerSubmodule");
    const ancestorIds = getAncestorChain(innerSubmodule, manifest.repositoryManifest).map(
        (occurrence) => occurrence.occurrenceId,
    );
    assert.deepEqual(ancestorIds, ["jfred/jfredToolsPlugin", "jfred", ""]);
});
```

### 1c. Leave these tests unmodified — they still pass under the new contract as-is
- `test_discoverTreeWithUnresolvedRepository_stopsBeforeCreatingOperationBranches`
  — `operationBranch` stays `""` regardless of resolution status now, assertion still holds.
- `test_resumedDiscoveryRun_doesNotRecreateCompletedOperationBranches` — discovery
  never checks anything out anymore, so the pre/post branch comparison still holds.
  (Its name is now slightly loose since discovery never created branches to begin
  with, but it's still a valid regression check and touching it isn't required —
  don't rename/restructure it, that's scope creep.)
- All other existing tests in this file (root/tree-shape/parent-edge/resolution-request
  tests) are unaffected — they don't touch `operationBranch`.

Do not modify `tests/operationBranches.test.ts` — it already calls
`setUpOperationBranches` directly with an explicit `runId` and already matches
the target contract.

## Step 2 (GREEN) — strip the branch-creation side effect out of `scripts/repositoryDiscovery.ts`

Remove the now-unused imports:
```ts
import { randomUUID } from "node:crypto";
```
and
```ts
import { setUpOperationBranches } from "./operationBranches.ts";
```

Replace the body of `discoverRepositoryTree` (currently lines ~152-168) so it stops
minting a `runId` and stops looping over occurrences to call `setUpOperationBranches`:

```ts
export function discoverRepositoryTree(rootPath: string, manifest: DiscoveryManifest): DiscoveryResult {
    const pendingResolutionRequests: ResolutionRequest[] = [];
    discoverOccurrenceAndDescendants(rootPath, "", null, null, 0, "", manifest, pendingResolutionRequests);

    if (pendingResolutionRequests.length > 0) {
        return { status: "needsResolution", resolutionRequests: pendingResolutionRequests };
    }

    return { status: "resolved", graph: manifest.repositoryManifest.occurrences };
}
```

`discoverOccurrenceAndDescendants` itself is untouched — it still carries forward
any previously-persisted `existing?.operationBranch ?? ""` onto the occurrence it
builds, which is correct: discovery reads what's already in the manifest, it just
no longer *creates* new branch state.

No changes to `scripts/operationBranches.ts`.

## Step 3 — verify
Run the two affected suites:
```
bun test tests/repositoryDiscovery.test.ts tests/operationBranches.test.ts
```
(Confirm this matches the project's actual test invocation from `package.json`
if it differs — the brief's test files use `node:test` + `node:assert/strict`.)

All tests in both files should pass:
- The 3 new tests confirm no branch/checkout side effect from `discoverRepositoryTree`.
- The modified integration test confirms `setUpOperationBranches`, called directly
  by the caller with its own `runId`, still creates and checks out branches, and
  that the `runId` used in the branch name is the one the caller passed in.
- Every other existing test in both files keeps passing unmodified.

## Files touched
- `scripts/repositoryDiscovery.ts` (production change)
- `tests/repositoryDiscovery.test.ts` (test change)

## Files intentionally not touched
- `scripts/operationBranches.ts` — already matches the target contract.
- `tests/operationBranches.test.ts` — already matches the target contract.
- Any other caller of `discoverRepositoryTree` found in Step 0 — out of scope for
  this task unless Step 0 finds one that breaks; if it does, stop and report back
  rather than silently expanding this task's diff.
</content>
