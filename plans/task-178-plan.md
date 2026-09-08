# Task 178 plan: run the configured typecheck in rebase-test

## Root cause

`rebaseAndTestSubmoduleLayer` (scripts/mergeTaskWorktrees.ts:260-310) and
`rebaseParentOntoSourceAndTest` (scripts/mergeTaskWorktrees.ts:358-385) each
run only `testPolicyResult.policy.completeSuiteCommand` via `execSync`.
Neither function accepts a typecheck command, so the rebase-test stage never
runs one, even though `tackleTasksBrief.ts` promises "typecheck + each
layer's complete test suite" for every rebase-test.

`skills/tackle-tasks/task.workflow.js` already computes
`TYPECHECK_COMMAND` (line 4, from `ARGS.typecheckCommand`, default `npx tsc
--noEmit`) and already uses it inside the worker's plain-English brief text
(lines 217, 232) for the implement stage — but `runRebaseTest` (lines
555-662) never passes it to `rebaseSubmoduleLayersDeepestFirst` or
`rebaseParentOntoSourceAndTest`.

Separately, `scripts/tackleTasksBrief.ts`'s merge-queue launch instruction
(line 169) launches `task.workflow.js` for the `rebase-test` and `merge`
stages with args `{task: taskNumber, stage, repositoryManifest, worktree}` —
this omits `typecheckCommand` entirely, so a rebase-test launched from the
merge queue (as opposed to the very first `plan+implement` launch, which
does receive it per lines 75-83) would fall back to
`task.workflow.js`'s hardcoded default instead of the pipeline's configured
value.

`scripts/testPolicy.ts` defines only `relatedTestCommand` and
`completeSuiteCommand`; it has no notion of a typecheck command and needs no
edit — the typecheck command is threaded as a separate parameter, not part
of the test policy.

## Fix

Add an optional `typecheckCommand: string | null = null` parameter (default
`null`, meaning "skip typecheck") to `rebaseAndTestSubmoduleLayer`,
`rebaseSubmoduleLayersDeepestFirst`, `rebaseParentOntoSourceAndTest`. When
non-null, run it via `execSync` in its own try/catch, before test-policy
discovery — so it runs unconditionally after a successful rebase, even for a
layer that has no complete-suite configuration and would otherwise return
`"untested"`. A typecheck failure produces the same `"tests-failed"` outcome
the suite failure already produces (no new status needed — every caller of
these two functions already treats `"tests-failed"` as a red layer that
blocks the merge).

The default of `null` means `mergeTaskDeepestFirst`'s existing calls to both
functions (used by the `merge` stage, not `rebase-test`) need no change —
they keep calling with the same argument lists they use today, so the merge
stage's behavior is unchanged. Only `task.workflow.js`'s `runRebaseTest`
passes a real `typecheckCommand`, and only `tackleTasksBrief.ts`'s launch
args need to carry that value all the way to every rebase-test launch (not
only the first one).

## Edits

### scripts/mergeTaskWorktrees.ts

**Edit 1** — function signature, lines 260-266. Current:
```
function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
    leaveConflictLive: boolean = false,
): SubmoduleLayerOutcome {
```
New:
```
function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
): SubmoduleLayerOutcome {
```

**Edit 2** — insert the typecheck run before test-policy discovery and its
`"untested"` early return, lines 295-309. Current:
```
    const testPolicyResult = discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { occurrenceId, checkoutPath, status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { occurrenceId, checkoutPath, status: "rebased-and-tested" };
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "tests-failed", testOutput: testFailureOutput(error) };
    }
```
New:
```
    if (typecheckCommand !== null) {
        try {
            execSync(typecheckCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            return { occurrenceId, checkoutPath, status: "tests-failed", testOutput: testFailureOutput(error) };
        }
    }

    const testPolicyResult = discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { occurrenceId, checkoutPath, status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { occurrenceId, checkoutPath, status: "rebased-and-tested" };
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "tests-failed", testOutput: testFailureOutput(error) };
    }
```
This runs the typecheck for every layer, including layers that have no
complete-suite configuration — the typecheck is no longer conditioned on
`discoverTestPolicy` succeeding.

**Edit 3** — exported wrapper signature, line 324. Current:
```
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest, leaveConflictLive: boolean = false): SubmoduleLayerWalkReport {
```
New:
```
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest, leaveConflictLive: boolean = false, typecheckCommand: string | null = null): SubmoduleLayerWalkReport {
```

**Edit 4** — call site inside that wrapper, line 341. Current:
```
        const outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId, leaveConflictLive);
```
New:
```
        const outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId, leaveConflictLive, typecheckCommand);
```

**Edit 5** — exported function signature, lines 358-365. Current:
```
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
    leaveConflictLive: boolean = false,
): ParentRebaseOutcome {
```
New:
```
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
): ParentRebaseOutcome {
```

**Edit 6** — insert the typecheck run before test-policy discovery and its
`"untested"` early return, lines 370-384. Current:
```
    const testPolicyResult = discoverTestPolicy(occurrenceId, worktreePath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: "rebased-and-tested" };
    } catch (error) {
        return { status: "tests-failed", testOutput: testFailureOutput(error) };
    }
```
New:
```
    if (typecheckCommand !== null) {
        try {
            execSync(typecheckCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            return { status: "tests-failed", testOutput: testFailureOutput(error) };
        }
    }

    const testPolicyResult = discoverTestPolicy(occurrenceId, worktreePath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: "rebased-and-tested" };
    } catch (error) {
        return { status: "tests-failed", testOutput: testFailureOutput(error) };
    }
```
Same reasoning as Edit 2: the typecheck now runs for every parent rebase,
including one with no test configuration.

No other edits in this file. `mergeTaskDeepestFirst`'s call to
`rebaseAndTestSubmoduleLayer` (line 561, `rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId)`)
and its call to `rebaseParentOntoSourceAndTest` (line 590,
`rebaseParentOntoSourceAndTest(occurrence.occurrenceId, occurrence.checkoutPath, occurrence.baseBranch, directChildPathsInParent, manifest.resolutionManifest)`)
are both left exactly as they are: they omit the new trailing parameter, so
`typecheckCommand` defaults to `null` and the merge stage's behavior is
unchanged.

### skills/tackle-tasks/task.workflow.js

**Edit 7** — line 611. Current:
```
  let layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
```
New:
```
  let layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true, TYPECHECK_COMMAND)
```

**Edit 8** — line 630. Current:
```
    layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
```
New:
```
    layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true, TYPECHECK_COMMAND)
```

**Edit 9** — line 638. Current:
```
  let parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
```
New:
```
  let parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true, TYPECHECK_COMMAND)
```

**Edit 10** — line 654. Current:
```
    parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
```
New:
```
    parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true, TYPECHECK_COMMAND)
```

`TYPECHECK_COMMAND` is already declared at the top of the file (line 4:
`const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'`) and
is in scope inside `runRebaseTest` by closure; no new import or declaration
is needed. `runMerge` is not touched — the merge stage keeps calling
`mergeTaskDeepestFirst` exactly as it does today (no typecheck parameter
exists on that function, and none is being added to it).

### scripts/tackleTasksBrief.ts

**Edit 11** — line 169, inside the merge-queue "## Merge queue" section, step
1's launch-args sentence. Current text (exact, as written inside the
template literal, backslash-escaped backticks included verbatim):
```
launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, repositoryManifest, worktree}\` — \`repositoryManifest\` is the pipeline args value from above and \`worktree\` is the \`worktree\` field of the \`groups\` entry whose \`tasks[0].number\` equals \`taskNumber\`
```
New text:
```
launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, typecheckCommand, repositoryManifest, worktree}\` — \`typecheckCommand\` is the pipeline args value from above (the same value passed to the very first launch), \`repositoryManifest\` is the pipeline args value from above and \`worktree\` is the \`worktree\` field of the \`groups\` entry whose \`tasks[0].number\` equals \`taskNumber\`
```
(Everything else on that line — the surrounding "1. Run `nextQueueStep(queue)`. ..." sentence before it and the "— add `taskNumber → stage` to `outstandingEntries` ..." sentence after it — is unchanged.)

No other edits in this file. Line 179's existing text ("Full verification
(typecheck + each layer's complete test suite) runs once per task, inside
that task's own rebase-test stage, before it can reach the merge queue's
merge stage.") already states the behavior this task makes true; it needs
no wording change.

### scripts/testPolicy.ts

No edit. `TestPolicy` and `discoverTestPolicy` have no typecheck concept and
none is added — `typecheckCommand` is threaded as a separate function
parameter in `mergeTaskWorktrees.ts`, not folded into the test policy this
file discovers.

### tests/mergeTaskWorktrees.test.ts

**Edit 12** — insert a new test immediately after the
`test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration`
test (which currently ends at line 1149 with `});` followed by a blank line
before the next `test(` at line 1151). Current text to match (the whole
existing test, used as the anchor):
```
test("test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest());

    assert.equal(outcome.status, "untested");
});
```
New text (same block, rewritten to also assert the typecheck runs even
though there is no test configuration, with a new test appended after it):
```
test("test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const markerPath = join(group.worktree, "typecheck-marker.txt");
    const typecheckCommand = `node -e "require('fs').writeFileSync('${markerPath}','ran')"`;
    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest(), false, typecheckCommand);

    assert.equal(outcome.status, "untested");
    assert.equal(readFileSync(markerPath, "utf8"), "ran");
});

test("test_rebaseParentOntoSourceAndTestReportsTestsFailedWhenTheTypecheckCommandFails", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "add test script");
    const sourceBranch = currentBranchName(repoRoot);

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group-work.txt"), "group work\n");
    git(group.worktree, "add", "group-work.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest(), false, "false");

    assert.equal(outcome.status, "tests-failed");
});
```

**Edit 13** — insert a second new test immediately after the
`test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents`
test (which currently ends at line 1194 with `});`, followed by a blank line
before the next `test(` at line 1196). Current text to match (the whole
existing test, used as the anchor):
```
test("test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(
        join(rootPath, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','parent-ran')\"" } }),
    );
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested"]);
    assert.equal(readFileSync(join(vendorCheckoutPath, "test-marker.txt"), "utf8"), "submodule-ran");
});
```
New text (same block, with a new test appended after it):
```
test("test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(
        join(rootPath, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','parent-ran')\"" } }),
    );
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested"]);
    assert.equal(readFileSync(join(vendorCheckoutPath, "test-marker.txt"), "utf8"), "submodule-ran");
});

test("test_rebaseSubmoduleLayersDeepestFirstReportsTestsFailedWhenTheTypecheckCommandFailsEvenThoughTheSuiteWouldPass", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest, false, "false");

    assert.notEqual(report.stoppedAt, null);
    assert.equal(report.stoppedAt !== null && report.stoppedAt.status, "tests-failed");
    assert.equal(existsSync(join(vendorCheckoutPath, "test-marker.txt")), false);
});
```

Both new tests reuse only helpers and imports already present in the file
(`makeTempRepoWithCommit`, `makeGroup`, `makeOccurrence`, `currentBranchName`,
`emptyResolutionManifest`, `REPOSITORY_MANIFEST_VERSION`, `DiscoveryManifest`,
`rebaseParentOntoSourceAndTest`, `rebaseSubmoduleLayersDeepestFirst`,
`existsSync`, `readFileSync`, `writeFileSync`, `git`, `join`) — no new
imports are needed. `"false"` is passed as the `typecheckCommand` string; it
is a POSIX shell builtin that always exits 1, so `execSync` throws before
the (passing) complete-suite command ever runs, proving the typecheck now
actually executes and blocks the layer.

## Verification

Run, from the repo root:

```
npx tsc --noEmit
```
Expected: no errors (the new parameters are all optional with defaults, so
every existing call site still type-checks).

```
npm test
```
Expected: all tests pass, including the two new ones —
`test_rebaseParentOntoSourceAndTestReportsTestsFailedWhenTheTypecheckCommandFails`
and
`test_rebaseSubmoduleLayersDeepestFirstReportsTestsFailedWhenTheTypecheckCommandFailsEvenThoughTheSuiteWouldPass`
— and no existing test's behavior changes (every existing call site omits
`typecheckCommand`, so it defaults to `null` and skips the new `execSync`
call exactly as before).

```
node --test tests/mergeTaskWorktrees.test.ts
```
Expected: same result as `npm test` for this one file, faster to iterate on
while implementing.
