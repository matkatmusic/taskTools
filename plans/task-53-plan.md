# Task 53 implementation plan: mint the run authorization in mergeTaskWorktrees and widen its CLI input to carry the evidence

Scope confirmed by reading the owned files directly (not from the brief's embedded copies — the live files were
read and match the brief's excerpts verbatim). No source file has been changed by this planning pass.

## Baseline (read-only, run before planning; nothing changed)

- `npx tsc --noEmit` — exit 0, no output (clean).
- `node --test tests/mergeTaskWorktrees.test.ts` — 12 tests, 12 pass, 0 fail.

## Design decisions (resolving every open question up front)

1. **"Repository manifest" and "occurrence data" are the same widening.** `RepositoryManifest` is
   `{ version: number; occurrences: RepositoryOccurrence[] }` (per the orchestrator's answered clarification) —
   the occurrences array *is* the occurrence data. One new field carries both: `repositoryManifest`.
2. **The manifest must be captured before merges run.** `scripts/prepareTasks.ts` already computes it (for task
   grouping) strictly before any worktree is merged back — it is the natural, already-existing capture point
   (ladder rung 2: reuse what's already computed). It currently discards the object after grouping; this plan
   makes it also emit that object on stdout as `repositoryManifest`, so it can ride the CLI JSON all the way to
   `mergeTaskWorktrees.ts` untouched. `mergeTaskWorktrees.ts` then reads `input.repositoryManifest` as the very
   first thing in `runPipelineCli`, before the merge loop, so `baseRef` reflects the pre-merge OID.
3. **`baseRef`** = `input.repositoryManifest.occurrences.find(o => o.parentOccurrenceId === null).baseOid`, read
   before the merge loop. Throws a clear error if the manifest or its root occurrence is missing (matches the
   existing style of `no recorded source branch for repository path "${path}"`).
4. **`operationRef`** = `git(workflowArguments.repo, "rev-parse", "HEAD").trim()`, read after the merge loop
   completes (the root repo stays checked out on `sourceBranch` throughout merging, so this is the post-merge
   root HEAD OID).
5. **`files`** for the digest = the deduplicated union of every task's declared files across every requested
   group: `[...new Set(sortedGroups.flatMap(g => g.tasks.flatMap(t => t.files)))]`. When approval is actually
   minted (`allGroupsMerged` true), `merged` and `sortedGroups` are the same set, so this is equivalent to using
   only the merged groups in the only case where it matters.
6. **Approval-minting gate** (codex requirement 4): `readyForApproval = allGroupsMerged && testReceipts.length >
   0 && testReceipts.every(r => r.status === "green") && reviewHandoffs.length > 0`, where `allGroupsMerged =
   conflicts.length === 0 && merged.length === sortedGroups.length` (this single expression captures both
   "conflicts is empty" and "every expected group merged" — they can't disagree given the loop always pushes
   each group's outcome to exactly one of `merged`/`conflicts`).
7. **Publication targets** (codex requirement 2) cover every occurrence in the manifest — root and every
   submodule — not just the root. The manifest is captured before any merge runs (decision 2), so each
   occurrence's `baseOid` is already the correct pre-merge OID for that occurrence's checkout path; the
   post-merge OID is read the same way, per occurrence, after the merge loop completes:
   `publicationTargets = allGroupsMerged ? input.repositoryManifest.occurrences.map(occurrence => ({
   repositoryPath: occurrence.checkoutPath, recordedBaseOid: occurrence.baseOid, targetOid:
   git(join(workflowArguments.repo, occurrence.checkoutPath), "rev-parse", "HEAD").trim() })) : []`. Gated on
   `allGroupsMerged` (merge success), not on the stricter `readyForApproval` (that gate additionally requires
   receipts/handoffs, a separate concern from "did the merge succeed"). `baseRef`/`operationRef` stay root-scoped
   as defined in decisions 3–4 — they feed only `digestInput`, not `publicationTargets`.
8. **`RunState.status`** is a free-form string in `approvalGate.ts` (only other writer sets it to `"review"` on
   drift, an unrelated code path). This plan sets `"approved"` when `readyForApproval` else `"blocked"` — new
   values, chosen because nothing else in the owned files defines this vocabulary.
9. **`scripts/approvalGate.ts` needs no edit.** `recordApproval` and `issueApprovalAuthorization` already have
   exactly the signatures this flow needs; this task only calls them from `mergeTaskWorktrees.ts`.
10. **`skills/tackle-tasks/merge.workflow.js` forwards `runState` and `publicationTargets` back out**, unchanged
    from what the CLI printed — this is what "task 49 needs it exposed" (brief requirement 3) means in practice:
    the workflow that calls the CLI must not swallow the fields the CLI now emits. `RUN_SCHEMA` gains `runState`
    (an object, nullable) and `publicationTargets` (an array); `runBrief`'s success branch echoes
    `result.stdout.runState`/`result.stdout.publicationTargets` and its forbidden-to-change list grows to include
    them; the failure branch (and the diagnose/retry-failed paths, which never re-ran a successful CLI) return
    `runState: null, publicationTargets: []`; the first-attempt-success and retry-success `return {...}` object
    literals both include `runState`/`publicationTargets` read from the corresponding CLI result.
11. **The one existing CLI-level test that predates this feature**
    (`test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge`) does not supply a manifest. Since
    `repositoryManifest` becomes a required `CliInput` field, this test is updated (not left broken) to pass one,
    built via a new small `makeManifest` test helper — it only asserts worktree/branch survival, so any valid
    manifest shape satisfies it.

## Edits

### scripts/mergeTaskWorktrees.ts

**Edit 1 — imports.** Current text (lines 12–14):
```
import { computeOccurrenceDigests } from "./approvalGate.ts";
import type { OccurrenceSnapshot } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
```
Becomes:
```
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization } from "./approvalGate.ts";
import type { OccurrenceSnapshot, RunState, ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";
```

**Edit 2 — widen `CliInput`.** Current text (lines 16–26):
```
type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};
```
Becomes:
```
type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
```

**Edit 3 — new `PublicationTarget` type.** Current text (lines 50–57, the end of the `MergeOutcome` block):
```
export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    submoduleConflicts: SubmoduleConflict[];
    worktree: string;
    failureReason: string | null;
};
```
Becomes (adds one line after the closing brace):
```
export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    submoduleConflicts: SubmoduleConflict[];
    worktree: string;
    failureReason: string | null;
};

export type PublicationTarget = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
```

**Edit 4 — read the manifest before any merge runs, and hoist the evidence defaults.** Current text (start of
`runPipelineCli`, lines 215–222):
```
function runPipelineCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    const workflowArguments: WorkflowArguments = {
        repo: input.repo,
        typecheckCommand: input.typecheckCommand,
        groups: input.groups,
        repositorySources: input.repositorySources,
    };
```
Becomes:
```
function runPipelineCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    if (!input.repositoryManifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const rootOccurrence = input.repositoryManifest.occurrences.find((occurrence) => occurrence.parentOccurrenceId === null);
    if (!rootOccurrence) throw new Error("repository manifest has no root occurrence");
    const baseRef = rootOccurrence.baseOid;
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const workflowArguments: WorkflowArguments = {
        repo: input.repo,
        typecheckCommand: input.typecheckCommand,
        groups: input.groups,
        repositorySources: input.repositorySources,
    };
```

**Edit 5 — capture `allGroupsMerged` and `operationRef` right after the merge loop.** Current text (lines
250–253, the end of the merge `for` loop and the start of the occurrence-snapshot computation):
```
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => {
```
Becomes:
```
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0 && merged.length === sortedGroups.length;
    const operationRef = git(workflowArguments.repo, "rev-parse", "HEAD").trim();
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => {
```

**Edit 6 — build `files`, `readyForApproval`, `digestInput`, `runState`, `publicationTargets`, and mint the
approval.** Current text (lines 263–264, right after `occurrenceDigests` is computed):
```
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const endTimestamp = new Date().toISOString();
```
Becomes:
```
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const readyForApproval = allGroupsMerged
        && testReceipts.length > 0
        && testReceipts.every((receipt) => receipt.status === "green")
        && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = {
        manifest: input.repositoryManifest,
        files,
        operationRef,
        baseRef,
        occurrenceDigests,
        testReceipts,
        reviewHandoffs,
    };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    if (readyForApproval) {
        recordApproval(runState);
        issueApprovalAuthorization(runState);
    }
    const publicationTargets: PublicationTarget[] = allGroupsMerged
        ? input.repositoryManifest.occurrences.map((occurrence) => ({
            repositoryPath: occurrence.checkoutPath,
            recordedBaseOid: occurrence.baseOid,
            targetOid: git(join(workflowArguments.repo, occurrence.checkoutPath), "rev-parse", "HEAD").trim(),
        }))
        : [];
    const endTimestamp = new Date().toISOString();
```

**Edit 7 — return the complete `RunState` and `publicationTargets`, not just a token.** Current text (lines
280–286, the final `process.stdout.write`):
```
    process.stdout.write(JSON.stringify({
        merged,
        conflicts,
        testReceipts: input.testReceipts ?? [],
        reviewHandoffs: input.reviewHandoffs ?? [],
        occurrenceDigests,
    }));
```
Becomes:
```
    process.stdout.write(JSON.stringify({
        merged,
        conflicts,
        testReceipts,
        reviewHandoffs,
        occurrenceDigests,
        runState,
        publicationTargets,
    }));
```
(`input.testReceipts ?? []` and `input.reviewHandoffs ?? []` are replaced by the already-hoisted `testReceipts`/
`reviewHandoffs` locals from Edit 4 — same values, computed once.)

### scripts/prepareTasks.ts

**Edit 1 — emit the already-computed manifest on stdout.** Current text (lines 619–624, the CLI's final
`process.stdout.write` in `runAsCli`):
```
    process.stdout.write(JSON.stringify({
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: mergeScriptPath(),
    }));
```
Becomes:
```
    process.stdout.write(JSON.stringify({
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: mergeScriptPath(),
        repositoryManifest: manifest,
    }));
```
(`manifest` is already in scope — it is the `const manifest = loadRepositoryManifest(repoRoot);` on line 178,
already computed strictly before this point and currently discarded after grouping.) No other edit is needed in
this file: `WorkflowArguments`, `buildWorkflowArguments`, and everything else stay as-is — the manifest rides
alongside the spread object as a sibling field, exactly like `runId`/`startTimestamp`/`mergeScript` already do.

### skills/tackle-tasks/merge.workflow.js

**Edit 1 — thread the manifest from ARGS into the merge CLI's input, without fabricating it.** Current text
(lines 42–57):
```
const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
  testReceipts: ARGS.testReceipts ?? [],
  reviewHandoffs: ARGS.reviewHandoffs ?? [],
}
```
Becomes (one new line, `repositoryManifest`, inserted right after `repositorySources` — a direct passthrough
with no default, matching how `repositorySources` itself is passed with no `?? []`):
```
const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  repositoryManifest: ARGS.repositoryManifest,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
  testReceipts: ARGS.testReceipts ?? [],
  reviewHandoffs: ARGS.reviewHandoffs ?? [],
}
```
`diagnoseBrief` is untouched — it never touches `runState`/`publicationTargets`. `RUN_SCHEMA`, `runBrief`, and
three `return {...}` statements do change, per design decision 10; Edits 2–5 below cover them.

**Edit 2 — widen `RUN_SCHEMA` to carry `runState` and `publicationTargets`.** Current text (lines 958–970):
```
const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    testReceipts: { type: 'array' },
    reviewHandoffs: { type: 'array', items: { type: 'string' } },
    occurrenceDigests: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'testReceipts', 'reviewHandoffs', 'occurrenceDigests', 'error'],
}
```
Becomes:
```
const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    testReceipts: { type: 'array' },
    reviewHandoffs: { type: 'array', items: { type: 'string' } },
    occurrenceDigests: { type: 'array', items: { type: 'string' } },
    runState: { type: ['object', 'null'] },
    publicationTargets: { type: 'array' },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'testReceipts', 'reviewHandoffs', 'occurrenceDigests', 'runState', 'publicationTargets', 'error'],
}
```
(`runState` is typed `['object', 'null']` because a failed CLI run returns `runState: null` — see Edit 3.)

**Edit 3 — forward `runState`/`publicationTargets` in `runBrief`'s two return branches, and add them to the
success-path prohibition.** Current text (the `runBrief` template's decision block and closing prohibition):
```
if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, testReceipts: result.stdout.testReceipts, reviewHandoffs: result.stdout.reviewHandoffs, occurrenceDigests: result.stdout.occurrenceDigests, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], testReceipts: [], reviewHandoffs: [], occurrenceDigests: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged, conflicts, testReceipts, reviewHandoffs, or occurrenceDigests values on
the success branch.`
```
Becomes:
```
if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, testReceipts: result.stdout.testReceipts, reviewHandoffs: result.stdout.reviewHandoffs, occurrenceDigests: result.stdout.occurrenceDigests, runState: result.stdout.runState, publicationTargets: result.stdout.publicationTargets, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], testReceipts: [], reviewHandoffs: [], occurrenceDigests: [], runState: null, publicationTargets: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, or
publicationTargets values on the success branch.`
```

**Edit 4 — propagate `runState`/`publicationTargets` through the first-attempt-success return and the
blocked/undiagnosed return.** Current text:
```
if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return {
    merged: firstMergeAttempt.merged,
    conflicts: [],
    testReceipts: firstMergeAttempt.testReceipts,
    reviewHandoffs: firstMergeAttempt.reviewHandoffs,
    occurrenceDigests: firstMergeAttempt.occurrenceDigests,
    fixedBlockers: null,
    blockers: [],
    decisions: [],
  }
}
```
Becomes:
```
if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return {
    merged: firstMergeAttempt.merged,
    conflicts: [],
    testReceipts: firstMergeAttempt.testReceipts,
    reviewHandoffs: firstMergeAttempt.reviewHandoffs,
    occurrenceDigests: firstMergeAttempt.occurrenceDigests,
    runState: firstMergeAttempt.runState,
    publicationTargets: firstMergeAttempt.publicationTargets,
    fixedBlockers: null,
    blockers: [],
    decisions: [],
  }
}
```
And current text:
```
if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    testReceipts: firstMergeAttempt?.testReceipts ?? [],
    reviewHandoffs: firstMergeAttempt?.reviewHandoffs ?? [],
    occurrenceDigests: [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}
```
Becomes:
```
if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    testReceipts: firstMergeAttempt?.testReceipts ?? [],
    reviewHandoffs: firstMergeAttempt?.reviewHandoffs ?? [],
    occurrenceDigests: [],
    runState: null,
    publicationTargets: [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}
```
(This branch never had a successful merge to report state for — `firstMergeAttempt` here is always the failed
first attempt — so `runState`/`publicationTargets` are always the failure shape, not read off `firstMergeAttempt`.)

**Edit 5 — propagate `runState`/`publicationTargets` through the retry return.** Current text:
```
return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  testReceipts: retry?.testReceipts ?? [],
  reviewHandoffs: retry?.reviewHandoffs ?? [],
  occurrenceDigests: retryFailed ? [] : (retry?.occurrenceDigests ?? []),
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
```
Becomes:
```
return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  testReceipts: retry?.testReceipts ?? [],
  reviewHandoffs: retry?.reviewHandoffs ?? [],
  occurrenceDigests: retryFailed ? [] : (retry?.occurrenceDigests ?? []),
  runState: retryFailed ? null : (retry?.runState ?? null),
  publicationTargets: retryFailed ? [] : (retry?.publicationTargets ?? []),
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
```
No other line in this file changes: the top-of-file `approvedByUser` refusal return, `diagnoseBrief`, and
`mergeResultCode` are untouched — none of them read or produce `runState`/`publicationTargets`.

### tests/mergeTaskWorktrees.test.ts

**Edit 1 — import the manifest type/constant.** Current text (line 10):
```
import { currentBranchName } from "../scripts/repositoryBranches.ts";
```
Becomes:
```
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
```

**Edit 2 — add a `makeManifest` test helper.** Current text (lines 35–40, between `makeGroup` and
`makeTempRepoWithLocalSubmodule`):
```
function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}

function makeTempRepoWithLocalSubmodule(): string {
```
Becomes:
```
function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}

type SubmoduleManifestSpec = { checkoutPath: string; baseBranch: string; baseOid: string; operationBranch: string };

function makeManifest(
    baseBranch: string,
    baseOid: string,
    operationBranch: string,
    submodules: SubmoduleManifestSpec[] = [],
): RepositoryManifest {
    const root = {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "",
        baseBranch,
        baseOid,
        operationBranch,
        childOccurrenceIds: submodules.map((_, index) => `sub-${index}`),
        testState: "untested" as const,
    };
    const subOccurrences = submodules.map((sub, index) => ({
        occurrenceId: `sub-${index}`,
        checkoutPath: sub.checkoutPath,
        parentOccurrenceId: "root",
        pathInParent: sub.checkoutPath,
        gitlinkOid: null,
        depth: 1,
        originUrl: "",
        baseBranch: sub.baseBranch,
        baseOid: sub.baseOid,
        operationBranch: sub.operationBranch,
        childOccurrenceIds: [],
        testState: "untested" as const,
    }));
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [root, ...subOccurrences] };
}

function makeTempRepoWithLocalSubmodule(): string {
```

**Edit 3 — fix the one pre-existing test that now needs a manifest.** Current text (lines 829–849, the whole
`test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge` test):
```
test("test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preparedGroup: PreparedGroup = group;
    const workflowArguments: WorkflowArguments = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [preparedGroup],
        repositorySources: [{ path: "", sourceBranch }],
    };
    execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(workflowArguments)], { encoding: "utf8" });

    assert.equal(existsSync(group.worktree), true);
    const branches = git(repoRoot, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});
```
Becomes:
```
test("test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preparedGroup: PreparedGroup = group;
    const workflowArguments: WorkflowArguments = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [preparedGroup],
        repositorySources: [{ path: "", sourceBranch }],
    };
    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = { ...workflowArguments, repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch) };
    execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });

    assert.equal(existsSync(group.worktree), true);
    const branches = git(repoRoot, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});
```
(`repositoryManifest` is added via a separate untyped `cliInput` object rather than by widening the
`WorkflowArguments`-typed `workflowArguments` variable, so TypeScript's excess-property check on that typed
literal is not triggered.)

**Edit 4 — append two new CLI-level tests, after the last existing test.** Current text (end of file, lines
280–308, the last test and the file's end):
```
test("test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", "merge");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    const resolution = resolveGitlinkConflicts(repoRoot, []);
    assert.equal(resolution.resolved, false);
    assert.ok(resolution.unexpectedConflicts.includes("shared.txt"));
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});
```
Becomes (unchanged, plus two new tests appended immediately after it, at the end of the file):
```
test("test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", "merge");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    const resolution = resolveGitlinkConflicts(repoRoot, []);
    assert.equal(resolution.resolved, false);
    assert.ok(resolution.unexpectedConflicts.includes("shared.txt"));
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(repoRoot);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const submoduleGroupBranch = currentBranchName(worktreeSubmodulePath);

    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");

    const preMergeRootOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const preMergeSubmoduleOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const testReceipts = [{ groupId: "1", status: "green" }];
    const reviewHandoffs = ["reviewed by codex"];
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: makeManifest(sourceBranch, preMergeRootOid, group.branch, [
            { checkoutPath: "vendor", baseBranch: submoduleSourceBranch, baseOid: preMergeSubmoduleOid, operationBranch: submoduleGroupBranch },
        ]),
        testReceipts,
        reviewHandoffs,
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);
    const postMergeRootOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const postMergeSubmoduleOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    assert.equal(output.runState.readyForApproval, true);
    assert.ok(output.runState.approval && output.runState.approval.digest.length > 0);
    assert.ok(output.runState.authorization);
    assert.deepEqual(output.runState.digestInput.testReceipts, testReceipts);
    assert.deepEqual(output.runState.digestInput.reviewHandoffs, reviewHandoffs);
    assert.deepEqual(output.publicationTargets, [
        { repositoryPath: "", recordedBaseOid: preMergeRootOid, targetOid: postMergeRootOid },
        { repositoryPath: "vendor", recordedBaseOid: preMergeSubmoduleOid, targetOid: postMergeSubmoduleOid },
    ]);
    assert.notEqual(preMergeRootOid, postMergeRootOid);
    assert.notEqual(preMergeSubmoduleOid, postMergeSubmoduleOid);
});

test("test_runPipelineCliProducesNoApprovalStateWhenAGroupConflicts", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.conflicts.length, 1);
    assert.equal(output.runState.readyForApproval, false);
    assert.equal(output.runState.approval, undefined);
    assert.equal(output.runState.authorization, undefined);
    assert.deepEqual(output.publicationTargets, []);
});
```

These two new tests prove the three things the brief requires: evidence reaching the pipeline (the
`digestInput.testReceipts`/`digestInput.reviewHandoffs` assertions echo back exactly what was passed in), a
conflicted run producing no approval state (the second test's `approval`/`authorization` are `undefined`), and
publication targets — for both the root repository and its submodule — keeping each occurrence's pre-merge base
OID while using that occurrence's post-merge target OID (the first test's `publicationTargets` assertion, backed
by the `assert.notEqual` pair proving both repositories actually advanced HEAD during the merge).

## Verification

Run, from `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit`
   Expected: exit 0, no output (matches the clean baseline recorded above; the new code only adds fields that
   satisfy the `ApprovalDigestInput`/`RunState`/`CliInput`/`RepositoryManifest` types already declared in the
   owned files, so no new type error is introduced).

2. `node --test tests/mergeTaskWorktrees.test.ts`
   Expected: `tests 14`, `pass 14`, `fail 0` (the existing 12 tests continue to pass — one of them,
   `test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge`, now supplies a manifest instead of
   crashing on the new required field — plus the 2 new tests:
   `test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen` and
   `test_runPipelineCliProducesNoApprovalStateWhenAGroupConflicts`).
