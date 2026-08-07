# Task 111 Plan: Populate operationBranch before any merge attempt

## Root cause (confirmed by reading source)

- `scripts/repositoryDiscovery.ts:582` sets every newly-discovered occurrence's `operationBranch` to `existing?.operationBranch ?? ""` — always `""` the first time an occurrence is discovered, because nothing upstream of it has ever set a real value.
- `scripts/prepareTasks.ts:216` writes that manifest straight to `.taskTools/run-arguments.json` as `repositoryManifest`, with `operationBranch` still `""` for every occurrence, and generates `runId` inline via `generateRunId()` without ever using it to populate `operationBranch`.
- `scripts/runMergePhase.ts:115` (`rewriteOperationBranches`, inside `coordinateMergeRetry`) requires every occurrence's `operationBranch` to start with `operations/{oldRunId}/`, else it returns `null`, which `coordinateMergeRetry` turns into `blockedVerdict(...)` at line 176. On a first-ever base-drift retry this is guaranteed to fire, because `operationBranch` is still `""`.
- `scripts/mergePipeline.ts:211-212` computes the *actual* branch name a successful run pushes to: it groups occurrences by `identityKey(occurrence)` (origin URL identity, falling back to `blank:{occurrenceId}` when there is no origin), assigns each group a `logicalId = sanitizeSegment(key)`, then calls `buildOperationPushOccurrences(manifest.occurrences, runId, operationBranchSegments)` where `operationBranchSegments` maps each occurrence to `sanitizeSegment(group.logicalId)`. The real pushed name is therefore `operations/{runId}/{sanitizeSegment(sanitizeSegment(identityKey(occurrence)))}` — **not** `scripts/operationBranches.ts:37`'s `operationBranchName(runId, occurrence)`, which produces `operations/{runId}/{occurrenceId-or-"root"}`. These are two different naming schemes; only the `mergePipeline.ts` one is what actually gets pushed and is what the guard should be validating against.
- `scripts/runMergePhase.ts:194` reads `run-arguments.json` into `runArguments` once, before the merge subprocess runs at line 204, and never re-reads it before passing that same in-memory copy into `coordinateMergeRetry`. Simply moving that read to *after* the subprocess call is not safe either: on a successful merge, `scripts/mergePipeline.ts`'s cleanup loop (`for (const resolvePath of [resolveRunArgumentsPath, ...]) rmSync(resolvePath(input.repo), { force: true })`) deletes `run-arguments.json`, so an unconditional post-subprocess read would throw on the common (non-drift, successful) path instead of returning the successful verdict.

## Fix (Option 3 from the brief: make the guard's invariant true upstream, using the branch name that is actually pushed)

Two problems, two fixes, both confined to the task's owned files:

1. **Naming mismatch.** Move the naming logic `mergePipeline.ts` actually uses when it pushes (`identityKey` + `sanitizeSegment`, and the grouping/dedup they imply) into `scripts/operationBranches.ts`, and change `buildOperationPushOccurrences` to compute that naming itself from `(occurrences, runId)` alone — no caller-supplied segment map. `scripts/prepareTasks.ts` then calls this same shared function to populate `operationBranch` before the manifest is ever persisted, so the value it writes to disk is byte-for-byte the same naming scheme `mergePipeline.ts` pushes to, not a different-looking-but-plausible stand-in. `scripts/mergePipeline.ts` switches to importing the moved helpers instead of keeping its own copies, and calls the now two-argument `buildOperationPushOccurrences`.
2. **Stale/unsafe re-read.** In `scripts/runMergePhase.ts`, re-read `run-arguments.json` only on the confirmed-base-drift path, never on the common successful path where the merge script has already deleted that file. Extract this into a small exported function (`resolveMergeVerdict`) that takes a lazy `readRunArguments` callback instead of a pre-fetched value, so the read demonstrably never happens unless `confirmedBaseDrift(initialVerdict)` is true — and so this branching is unit-testable without touching the filesystem.

`scripts/repositoryDiscovery.ts` needs no edit — see "Files needing no edit" below for why.

## Edits

### scripts/operationBranches.ts

**Edit 1 — add imports.** Current lines 1-3:

```
// Creates per-occurrence operation branches at their recorded base OID, checks them out, and records the branch name.
import { execFileSync } from "node:child_process";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
```

Becomes:

```
// Creates per-occurrence operation branches at their recorded base OID, checks them out, and records the branch name.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { normalizeRepositoryIdentity } from "./submoduleUrlIdentity.ts";
```

**Edit 2 — add `sanitizeSegment` and `identityKey`, exported.** Insert immediately after the existing `operationBranchName` function (current lines 37-40):

```
export function operationBranchName(runId: string, occurrence: RepositoryOccurrence): string {
    const occurrenceSegment = occurrence.occurrenceId === "" ? "root" : occurrence.occurrenceId;
    return `operations/${runId}/${occurrenceSegment}`;
}
```

Becomes (new functions added directly below, nothing above changes):

```
export function operationBranchName(runId: string, occurrence: RepositoryOccurrence): string {
    const occurrenceSegment = occurrence.occurrenceId === "" ? "root" : occurrence.occurrenceId;
    return `operations/${runId}/${occurrenceSegment}`;
}

export function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}

export function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
```

These are copied verbatim from `scripts/mergePipeline.ts`'s current `sanitizeSegment` (lines 34-37) and `identityKey` (lines 55-59) — same behavior, new home. `operationBranchName` itself is left in place unchanged; it stays exported and is still used by `setUpOperationBranches`.

**Edit 3 — replace `buildOperationPushOccurrences`.** Current lines 76-86:

```
export function buildOperationPushOccurrences(
    occurrences: RepositoryOccurrence[],
    runId: string,
    segmentByOccurrenceId: Map<string, string>,
): RepositoryOccurrence[] {
    return occurrences.map((occurrence) => {
        const segment = segmentByOccurrenceId.get(occurrence.occurrenceId);
        if (segment === undefined) throw new Error(`no operation-branch segment for occurrence "${occurrence.occurrenceId}"`);
        return { ...occurrence, operationBranch: `operations/${runId}/${segment}` };
    });
}
```

Becomes:

```
export function buildOperationPushOccurrences(
    occurrences: RepositoryOccurrence[],
    runId: string,
): RepositoryOccurrence[] {
    const logicalIdByIdentity = new Map<string, string>();
    for (const occurrence of occurrences) {
        const key = identityKey(occurrence);
        if (!logicalIdByIdentity.has(key)) logicalIdByIdentity.set(key, sanitizeSegment(key));
    }
    return occurrences.map((occurrence) => {
        const logicalId = logicalIdByIdentity.get(identityKey(occurrence))!;
        return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalId)}` };
    });
}
```

Why this reproduces `mergePipeline.ts`'s exact current naming: it groups occurrences by `identityKey` first (so occurrences sharing an origin identity share one `logicalId`, matching `buildLogicalGroups`'s dedup), sets `logicalId = sanitizeSegment(key)` (matching `buildLogicalGroups`'s `logicalId: sanitizeSegment(key)`), then applies `sanitizeSegment` to `logicalId` a second time when building the branch name (matching `operationBranchSegments`'s `sanitizeSegment(group.logicalId)`). The double `sanitizeSegment` looks redundant but is intentional: it is `mergePipeline.ts`'s current observable behavior, and this edit's job is to centralize that behavior, not change it.

Why the third parameter is dropped: the caller-supplied `segmentByOccurrenceId` map was the only thing forcing every caller to duplicate `mergePipeline.ts`'s grouping logic before it could call this function. Computing the grouping internally from `(occurrences, runId)` alone means `scripts/prepareTasks.ts` — which has no `LogicalGroup` machinery and should not need any — can now call this function directly.

### scripts/mergePipeline.ts

**Edit 1 — import the moved helpers instead of duplicating them.** Current line 11:

```
import { buildOperationPushOccurrences } from "./operationBranches.ts";
```

Becomes:

```
import { buildOperationPushOccurrences, identityKey, sanitizeSegment } from "./operationBranches.ts";
```

**Edit 2 — delete the now-duplicate local `sanitizeSegment`.** Current lines 34-37:

```
function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}
```

Delete this function entirely. `createHash` stays imported (line 3) and stays used elsewhere in this file, by `digestIds` (current line 38: `function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }`) — do not touch that import or that function. Every other call site in this file that currently calls the local `sanitizeSegment` (`occurrenceSegment = sanitizeSegment(occurrenceId)`, `proxyId`, `finalizationRunId`, `integrationRef`, and inside `buildLogicalGroups`'s `logicalId: sanitizeSegment(key)`) needs no text change — the identifier `sanitizeSegment` now resolves to the imported one instead of the deleted local one.

**Edit 3 — delete the now-duplicate local `identityKey`.** Current lines 55-59:

```
function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
```

Delete this function entirely. `normalizeRepositoryIdentity` stays imported (current line 12) and stays used elsewhere in this file, directly inside `runMergePipeline` (current line 214: `normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? (...)`) — do not touch that import or that call. `buildLogicalGroups`'s `const key = identityKey(occurrence);` needs no text change — it now resolves to the imported `identityKey`.

**Edit 4 — drop the segment map, call the two-argument `buildOperationPushOccurrences`.** Current lines 211-212:

```
        const operationBranchSegments = new Map(logicalGroups.flatMap((group) => group.occurrenceIds.map((id) => [id, sanitizeSegment(group.logicalId)] as const)));
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId, operationBranchSegments);
```

Becomes:

```
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
```

Nothing downstream of `operationPushOccurrences` changes — `buildOperationPushOccurrences` still returns the same shape it always did, computing the identical branch names it computed before (see the "why this reproduces" note in the `operationBranches.ts` edit above), just without needing a map built and passed in by the caller.

### scripts/prepareTasks.ts

**Edit 1 — add the import.** Current lines 10-12:

```
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";

```

Becomes:

```
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";
import { buildOperationPushOccurrences } from "./operationBranches.ts";

```

(Inserts one new import line; the following blank line at the old line 12 is preserved as-is.)

**Edit 2 — hoist `runId`, populate `operationBranch` with the same naming `mergePipeline.ts` pushes, reuse `runId` below.** Current lines 209-220:

```
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const manifest = loadRepositoryManifest(repoRoot);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    // startTimestamp is stamped here because workflow scripts cannot call Date.now().
    const pipelineArguments = {
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: resolveMergeScriptPath(),
        repositoryManifest: manifest,
    };
```

Becomes:

```
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const runId = generateRunId();
    const manifest = loadRepositoryManifest(repoRoot);
    manifest.occurrences = buildOperationPushOccurrences(manifest.occurrences, runId);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    // startTimestamp is stamped here because workflow scripts cannot call Date.now().
    const pipelineArguments = {
        ...workflowArguments,
        runId,
        startTimestamp: new Date().toISOString(),
        mergeScript: resolveMergeScriptPath(),
        repositoryManifest: manifest,
    };
```

Why here and not in `repositoryDiscovery.ts`: `discoverRepositoryTree` / `discoverOccurrenceAndDescendants` take no `runId` parameter — they build the occurrence graph before any run identity exists, so they cannot produce a meaningful `operations/{runId}/...` value. `runId` first exists in `prepareTasks.ts`'s `runAsCli()`, and that is also the only place that writes `repositoryManifest` to `.taskTools/run-arguments.json` (line 223, unchanged), so overwriting `operationBranch` there guarantees the on-disk value is correct before any merge attempt starts.

Why `buildOperationPushOccurrences` and not `operationBranchName`: `operationBranchName(runId, occurrence)` produces `operations/{runId}/{occurrenceId-or-"root"}`, which is a *different* naming scheme from what `mergePipeline.ts` actually pushes (`operations/{runId}/{sanitizeSegment(sanitizeSegment(identityKey(occurrence)))}` — see Root cause above). Populating `operationBranch` with `operationBranchName` would satisfy the guard's prefix check (`operations/{runId}/`) without making its invariant *true* — the persisted value would still not match the real pushed branch name. Calling the same `buildOperationPushOccurrences` function that `mergePipeline.ts` calls when it pushes guarantees both call sites derive the name identically, by construction, not by coincidence.

### scripts/runMergePhase.ts

**Edit 1 — extract a small, lazily-reading, unit-testable retry-verdict resolver.** Insert this new exported function directly above `function runAsCli(): void {` (i.e., immediately after `coordinateMergeRetry`'s closing brace, current line 214):

```
export function resolveMergeVerdict(
    initialVerdict: MergePhaseVerdict,
    readRunArguments: () => CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    if (!confirmedBaseDrift(initialVerdict)) return initialVerdict;
    // Re-read only here: a successful merge deletes run-arguments.json, so an unconditional read would throw.
    return coordinateMergeRetry(readRunArguments(), mergeCommand, deps);
}
```

**Edit 2 — use it from `runAsCli`, reading `run-arguments.json` lazily instead of eagerly.** Current lines 193-207:

```
    const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
    const runArguments: CliInput = JSON.parse(readFileSync(runArgumentsPath, "utf8"));
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
    const deps: MergeRetryDeps = {
        runScript,
        generateRunId,
        readRefOid: readCurrentRefOid,
        writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
        rebaseGroupOntoSource,
        discoverTestPolicy,
    };
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = confirmedBaseDrift(initialVerdict) ? coordinateMergeRetry(runArguments, command, deps) : initialVerdict;
    process.stdout.write(JSON.stringify(verdict));
}
```

Becomes:

```
    const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
    const deps: MergeRetryDeps = {
        runScript,
        generateRunId,
        readRefOid: readCurrentRefOid,
        writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
        rebaseGroupOntoSource,
        discoverTestPolicy,
    };
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = resolveMergeVerdict(
        initialVerdict,
        () => JSON.parse(readFileSync(runArgumentsPath, "utf8")),
        command,
        deps,
    );
    process.stdout.write(JSON.stringify(verdict));
}
```

This removes the single eager `runArguments` read (which happened before the merge subprocess ran, and was therefore stale on the retry path, and would also have been reading a file the successful path is about to delete) and replaces it with a callback that `resolveMergeVerdict` only invokes when `confirmedBaseDrift(initialVerdict)` is true. `CliInput`, `readFileSync`, and `resolveRunArgumentsPath` are all already imported and used elsewhere in the file, so no import changes are needed for this edit.

## Files needing no edit

- **scripts/repositoryDiscovery.ts** — `discoverOccurrenceAndDescendants` has no `runId` in scope and cannot compute a real operation-branch name; the `""` it writes at line 582 is unconditionally overwritten by the `prepareTasks.ts` edit above before the manifest is ever persisted, so nothing here contributes to the bug once `prepareTasks.ts` is fixed.

## Tests

### tests/runMergePhase.test.ts

Add two permanent tests. Update the import line at the top of the file. Current:

```
import { buildMergeOutcomes, judgeMergeRun } from "../scripts/runMergePhase.ts";
```

Becomes:

```
import { buildMergeOutcomes, judgeMergeRun, resolveMergeVerdict, type MergePhaseVerdict, type MergeRetryDeps } from "../scripts/runMergePhase.ts";
import { buildOperationPushOccurrences } from "../scripts/operationBranches.ts";
import type { CliInput } from "../scripts/mergePipeline.ts";
```

Append these two tests at the end of the file, after `test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing`:

```
test("test_resolveMergeVerdictRetriesWithPopulatedOperationBranchesOnConfirmedBaseDrift", () => {
    const occurrence: CliInput["repositoryManifest"]["occurrences"][number] = {
        occurrenceId: "", checkoutPath: "/tmp/repo", parentOccurrenceId: null, pathInParent: null,
        gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "oldoid",
        operationBranch: "", childOccurrenceIds: [], testState: "untested",
    };
    const [populatedOccurrence] = buildOperationPushOccurrences([occurrence], "oldrun123");
    const group: CliInput["groups"][number] = { groupId: 1, worktree: "/tmp/repo", branch: "task-group-1", scope: "narrow", tasks: [] };
    const runArguments: CliInput = {
        repo: "/tmp/repo", typecheckCommand: "true",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch: "main" }],
        runId: "oldrun123",
        repositoryManifest: { version: 1, occurrences: [populatedOccurrence] },
    };
    const deps: MergeRetryDeps = {
        runScript: () => ({ exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [{ x: 1 }] }), stderr: "" }),
        generateRunId: () => "newrun456",
        readRefOid: () => "deadbeef",
        writeRunArguments: () => {},
        rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
        discoverTestPolicy: () => ({ status: "resolved", policy: { completeSuiteCommand: "true" } }),
    };
    const initialVerdict: MergePhaseVerdict = {
        status: "blocked",
        result: { abortReason: "the source branch moved past the pinned baseOid" },
        failure: { repo: "/tmp/repo", failedCommand: "cmd", conflicts: [], error: "" },
    };

    const verdict = resolveMergeVerdict(initialVerdict, () => runArguments, ["node", "merge"], deps);

    assert.equal(verdict.status, "merged");
});

test("test_resolveMergeVerdictDoesNotReadRunArgumentsWhenInitialVerdictIsNotConfirmedBaseDrift", () => {
    const mergedVerdict: MergePhaseVerdict = { status: "merged", result: { conflicts: [], publicationTargets: [{ x: 1 }] }, failure: null };
    let readCount = 0;
    const readRunArguments = () => {
        readCount++;
        throw new Error("must not read run-arguments.json: mergePipeline.ts deletes it after a successful merge");
    };
    const deps: MergeRetryDeps = {
        runScript: () => { throw new Error("must not run the merge command again"); },
        generateRunId: () => "unused",
        readRefOid: () => "unused",
        writeRunArguments: () => {},
        rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
        discoverTestPolicy: () => ({ status: "resolved", policy: { completeSuiteCommand: "true" } }),
    };

    const verdict = resolveMergeVerdict(mergedVerdict, readRunArguments, ["node", "merge"], deps);

    assert.equal(readCount, 0);
    assert.equal(verdict, mergedVerdict);
});
```

The first test starts from an occurrence exactly as discovery produces it — `operationBranch` still the empty string, the state that caused the live repro in the brief — populates it via `buildOperationPushOccurrences`, which is precisely what the `prepareTasks.ts` edit now does before any merge attempt, and then verifies that this corrected persisted shape clears the guard and lets a confirmed-base-drift retry through `resolveMergeVerdict` reach `"merged"`. It asserts the fix's post-condition, not that an unpopulated occurrence can retry — an unpopulated one still fail-closes, and that is intended. The second test directly guards against the regression this review caught: an unconditional re-read would have thrown on every successful (non-drift) run, because `mergePipeline.ts` deletes `run-arguments.json` on success; asserting `readCount === 0` proves the read is still lazy and gated on `confirmedBaseDrift`.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools` after making all edits:

1. Typecheck (the project's own typecheck command, per `DEFAULT_TYPECHECK_COMMAND` in `scripts/prepareTasks.ts`):
   ```
   npx tsc --noEmit
   ```
   Expected: exits 0, no errors.

2. Regression suite, including the two new tests (9 total: the 7 pre-existing tests plus the 2 added above):
   ```
   bun test tests/runMergePhase.test.ts
   ```
   Expected: all 9 tests pass, 0 failures.

3. Structural check that every edit landed where intended:
   ```
   rg -n "export function sanitizeSegment|export function identityKey" scripts/operationBranches.ts
   rg -n "^import \{ buildOperationPushOccurrences, identityKey, sanitizeSegment \}" scripts/mergePipeline.ts
   rg -n "^function sanitizeSegment|^function identityKey" scripts/mergePipeline.ts
   rg -n "buildOperationPushOccurrences" scripts/prepareTasks.ts
   rg -n "export function resolveMergeVerdict" scripts/runMergePhase.ts
   ```
   Expected: the first shows both new exports in `operationBranches.ts`; the second shows the updated import in `mergePipeline.ts`; the third shows **no matches** (both local duplicates deleted); the fourth shows the new import and the `manifest.occurrences = buildOperationPushOccurrences(...)` line in `prepareTasks.ts`; the fifth shows the new exported function in `runMergePhase.ts`.
