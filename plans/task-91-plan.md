# Plan: Task 91 — exported retry coordinator with rewritten operation branches and refreshed base OIDs

## Scope (final, per third mandatory amendment in the brief)

Exactly three owned files, no others:
1. `scripts/runMergePhase.ts` (currently 71 lines)
2. `scripts/mergePipeline.ts` (currently 249 lines — 1 line under the 250 cap)
3. `scripts/operationBranches.ts` (currently 74 lines)

No test file is created or edited by this plan — `tests/runMergePhase.test.ts` belongs to task 90, and the
top-level planning instructions for this task direct ordinary verification commands instead of TDD.

## Naming-scheme decision (brief's amendment item 1)

Two competing `operationBranch` prefixes exist today:
- `scripts/operationBranches.ts:39` (`operationBranchName`) produces `tackle-op/{runId}/{occurrenceId}`. This
  function's only caller, `setUpOperationBranches`, has zero callers anywhere in `scripts/`, so this prefix is
  dead code that never reaches a persisted manifest.
- `scripts/mergePipeline.ts:212` produces `operations/{runId}/{sanitizeSegment(logicalGroup.logicalId)}` and
  feeds `pushOperationBranches`, i.e. it is the prefix that actually gets used for real pushed branches.

**Winner: `operations/{runId}/{segment}`.** It is the value already wired into production pushes and it matches
what the original (pre-amendment) task text assumed occurrences would carry. `tackle-op/...` is renamed to
match so the two owned files that talk about operation branches never disagree.

## File 1: `scripts/operationBranches.ts`

### Edit 1.1 — align the dead-code naming scheme with the winning prefix

Current text (line 39):
```
    return `tackle-op/${runId}/${occurrenceSegment}`;
```
becomes:
```
    return `operations/${runId}/${occurrenceSegment}`;
```

### Edit 1.2 — add the extracted operation-push-occurrence builder

Append after the current final line (line 74, `}`, end of file) this new exported function, preceded by one
blank line:
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
`RepositoryOccurrence` is already imported at line 3 (`import type { RepositoryOccurrence } from "./repositoryManifest.ts";`) — no new import needed. The local `segment` variable and explicit throw (instead of interpolating a possibly-`undefined` map lookup straight into the template string) guard against silently emitting an `operations/{runId}/undefined` branch name when `segmentByOccurrenceId` lacks an entry for an occurrence.

Resulting file length: 74 + 1 blank + 11 = 86 lines (verified by writing this exact content to a scratch file
and running `wc -l`). Well under the 250 cap.

This function reproduces the exact byte-for-byte output of the code it replaces in `mergePipeline.ts` (see
Edit 2.2): it takes a precomputed `occurrenceId -> sanitized-segment` map instead of re-deriving the segment
from a `LogicalGroup[]` array, so `operationBranches.ts` does not need to import `sanitizeSegment` or any
`mergePipeline.ts`-local type, avoiding a value-level circular import between the two owned files.

## File 2: `scripts/mergePipeline.ts`

### Edit 2.1 — import the extracted builder

Current text (line 10, unchanged, shown for anchoring):
```
import { validateRepositoryManifest, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
```
Insert this new line immediately after it (becomes new line 11; every subsequent original line shifts down by one):
```
import { buildOperationPushOccurrences } from "./operationBranches.ts";
```

### Edit 2.2 — replace the inline map with the extracted call

Current text (original lines 210-213):
```
        const operationPushOccurrences = manifest.occurrences.map((occurrence) => {
            const logicalGroup = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}` };
        });
```
becomes:
```
        const operationBranchSegments = new Map(logicalGroups.flatMap((group) => group.occurrenceIds.map((id) => [id, sanitizeSegment(group.logicalId)] as const)));
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId, operationBranchSegments);
```
(After Edit 2.1 shifts line numbers by +1, these are the lines immediately following `const operationPushLogicalRepositories...` block's preceding closing brace — i.e. originally-numbered lines 210-213, now at 211-214 before this edit, replaced by 2 lines.)

`operationPushOccurrences` keeps the same inferred type (`RepositoryOccurrence[]`) it had before, since the
extracted function's return type is `RepositoryOccurrence[]` and the original inline map produced values
structurally identical to `RepositoryOccurrence` (an occurrence spread with `operationBranch` overridden to a
`string`, which is already `RepositoryOccurrence`'s field type). The later use of `operationPushOccurrences` in
`pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest)` is untouched and needs no further edit.

`sanitizeSegment`, `logicalGroups`, `runId`, and `manifest` all remain in scope exactly as before — no other
line in `mergePipeline.ts` changes.

Net line delta: +1 (new import) −4 (removed block) +2 (replacement) = −1. New file length: 249 − 1 = 248 lines.
Still under the 250 cap, with 2 lines of headroom.

## File 3: `scripts/runMergePhase.ts`

This file is rewritten almost in full: the four unchanged pieces are `StepOutputs`, `MergeFailure`/
`MergePhaseVerdict`, `buildMergeOutcomes`, and `judgeMergeRun` (the task-63 guard), copied verbatim byte-for-byte
from the current file with zero modification, per the brief's explicit "must keep working... left intact"
requirement. Everything else (imports, `runScript`, `runAsCli`, and all new code) is new or changed.

Replace the entire current file content (all 71 lines) with:

```ts
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCurrentRefOid } from "./basePublication.ts";
import type { CliInput } from "./mergePipeline.ts";
import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";

export type StepOutputs = {
    done?: unknown[];
    partial?: unknown[];
    blocked?: unknown[];
    needsClarification?: unknown[];
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};

export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

export function buildMergeOutcomes(steps: StepOutputs) {
    return {
        doneCount: steps.done?.length ?? 0,
        partialCount: steps.partial?.length ?? 0,
        blockedCount: steps.blocked?.length ?? 0,
        needsClarificationCount: steps.needsClarification?.length ?? 0,
        requeueCount: steps.requeueCount ?? 0,
        testReceipts: steps.testReceipts ?? [],
        reviewHandoffs: steps.reviewHandoffs ?? [],
    };
}

type ScriptRun = { exitCode: number; stdout: string; stderr: string };

export function judgeMergeRun(run: ScriptRun, repo: string, failedCommand: string): MergePhaseVerdict {
    const blocked = (error: string, conflicts: unknown[], result: unknown): MergePhaseVerdict =>
        ({ status: "blocked", result, failure: { repo, failedCommand, conflicts, error } });
    if (run.exitCode !== 0) return blocked(`${run.exitCode}: ${run.stderr || run.stdout}`, [], null);
    let output: { conflicts?: unknown[]; publicationTargets?: unknown[] };
    try {
        output = JSON.parse(run.stdout);
    } catch {
        return blocked(`merge script printed output that is not JSON: ${run.stdout.slice(0, 500)}`, [], null);
    }
    if ((output.conflicts?.length ?? 0) > 0) return blocked("", output.conflicts!, output);
    if ((output.publicationTargets?.length ?? 0) === 0)
        return blocked("merge script exited clean but published nothing (publicationTargets is empty): the run was not ready for approval, or the source branch moved past its pinned baseOid before publish", [], output);
    return { status: "merged", result: output, failure: null };
}

function runScript(command: string[], cwd?: string): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
    const result = verdict.result as { abortReason?: string | null } | null;
    return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
}

function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
    return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
}

function describeRebaseFailure(outcome: RebaseOutcome): string {
    return outcome.status === "conflicted"
        ? `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`
        : outcome.failureReason;
}

function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string {
    const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath);
    const relativePath = relative(resolve(repoRoot), absoluteCheckout);
    return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath);
}

function mintFreshRunId(generate: () => string, oldRunId: string): string {
    const candidate = generate();
    return candidate === oldRunId ? `${candidate}-retry` : candidate;
}

function rewriteOperationBranches(
    occurrences: RepositoryOccurrence[],
    oldRunId: string,
    newRunId: string,
): RepositoryOccurrence[] | null {
    const oldPrefix = `operations/${oldRunId}/`;
    const rewritten: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        if (!occurrence.operationBranch.startsWith(oldPrefix)) return null;
        rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` });
    }
    return rewritten;
}

function refreshBaseOids(
    repoRoot: string,
    occurrences: RepositoryOccurrence[],
    readRefOid: (repoRoot: string, ref: string) => string | null,
): RepositoryOccurrence[] | null {
    const refreshed: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath);
        const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`);
        if (oid === null) return null;
        refreshed.push({ ...occurrence, baseOid: oid });
    }
    return refreshed;
}

export type MergeRetryDeps = {
    runScript: (command: string[], cwd?: string) => ScriptRun;
    generateRunId: () => string;
    readRefOid: (repoRoot: string, ref: string) => string | null;
    writeRunArguments: (data: unknown) => void;
    rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
    discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
};

export function coordinateMergeRetry(
    runArguments: CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch;
    if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root");

    for (const group of runArguments.groups) {
        const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch);
        if (rebaseOutcome.status !== "rebased-clean") {
            return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome));
        }
        for (const occurrence of runArguments.repositoryManifest.occurrences) {
            const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath);
            const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest());
            if (policyResult.status !== "resolved") {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`);
            }
            const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath);
            if (testRun.exitCode !== 0) {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`);
            }
        }
    }

    const oldRunId = runArguments.runId;
    if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from");
    const newRunId = mintFreshRunId(deps.generateRunId, oldRunId);
    const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId);
    if (rewrittenOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`);
    }
    const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid);
    if (refreshedOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence");
    }

    const updatedArguments: CliInput = {
        ...runArguments,
        runId: newRunId,
        repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences },
    };
    deps.writeRunArguments(updatedArguments);

    const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" "));
    if (resultIndicatesBaseDrift(retryVerdict)) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt");
    }
    return retryVerdict;
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
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

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

Resulting file length: 210 lines (verified by writing this exact content to a scratch file and running
`wc -l`). Well under the 250 cap.

### Design notes tying the code to every brief requirement

- **Exported, testable coordinator (finding 5 / amendment 3 item 1):** `coordinateMergeRetry` is exported,
  fully dependency-injected via `MergeRetryDeps`, and owns the entire retry flow: rebase every group and gate on
  post-rebase tests → mint a fresh runId, rewrite `operationBranch`, refresh base OIDs, write
  `run-arguments.json` → invoke the merge script exactly once → return that verdict. It never runs the initial
  merge. `runAsCli()` resolves paths, builds the real `deps`, runs and judges the initial merge, and calls
  `coordinateMergeRetry` only when that first verdict is a confirmed base drift; otherwise it emits the first
  verdict unchanged.
- **Fresh runId + rewritten occurrences before `run-arguments.json` is rewritten (finding 2):**
  `rewriteOperationBranches` computes every occurrence's new `operationBranch` in memory and returns `null` (→
  blocked, zero further merge-script invocations) the moment one occurrence's current `operationBranch` does not
  start with `operations/{oldRunId}/`. Only after that succeeds, and after `refreshBaseOids` also succeeds, is
  `deps.writeRunArguments` called once with the fully updated object (new `runId` + rewritten + refreshed
  occurrences) — satisfying "before rewriting run-arguments.json" as one atomic write of the final state, not
  two writes.
- **Refreshed per-occurrence base OIDs, relative paths resolved against `repoRoot`, fail-closed:**
  `refreshBaseOids` resolves each `occurrence.checkoutPath` against `repoRoot` with `isAbsolute`/`join` (mirrors
  `mergePipeline.ts`'s `buildCoordinates`), reads `refs/heads/{baseBranch}` via the injected `readRefOid`, and
  returns `null` (blocked) the instant any lookup returns `null` — never falls back to the stale OID.
- **Exactly one retry, no loop, no recursion:** `coordinateMergeRetry` contains exactly one `deps.runScript(mergeCommand)` call site in its whole body — the single retry call. There is no loop or recursive call around it; the code between that call and the function's two `return` statements only inspects `retryVerdict`, it never calls `runScript` with `mergeCommand` again. The initial merge lives in `runAsCli()` and is not the coordinator's concern.
- **Task-63 guard preserved exactly:** `judgeMergeRun` is copied byte-for-byte from the current file; its
  `publicationTargets.length === 0` → blocked branch (the guard) is untouched.
- **Bounded, deterministic fresh-runId minting:** `mintFreshRunId` calls `generate()` exactly once and, on the
  (practically unreachable, since real `generateRunId` is randomized) case where it collides with `oldRunId`,
  deterministically appends `-retry` rather than looping — no risk of an infinite loop if a fake or future
  generator ever returned a fixed value.
- **Post-rebase test signal via the real mechanism, not `typecheckCommand`:** the rebase/retest gate calls the
  injected `discoverTestPolicy`; a `needsResolution` result blocks without guessing a command; a `resolved`
  result runs `policy.completeSuiteCommand` via `deps.runScript(["sh", "-c", command], cwd)` — handing the whole
  command string to a shell rather than splitting on spaces (satisfies "never `command.split(" ")`" while still
  allowing an opaque command string with quoted arguments).
- **No new dependency, no new file:** `sh -c` is POSIX-standard and already how a shell interprets a command
  string; no package was added. The coordinator lives entirely inside the already-owned `runMergePhase.ts` — no
  fourth file was created, matching "exactly these three, and no others."
- **Second base-drift / empty-publication on retry → blocked, no third attempt:** after the retry call,
  `retryVerdict` is checked two ways before anything is returned. First, `judgeMergeRun` itself already blocks
  when the retry's `publicationTargets` comes back empty (the task-63 guard). Second, `resultIndicatesBaseDrift`
  inspects the retry's parsed `abortReason` directly — independent of whether `judgeMergeRun` called it `merged`
  or `blocked` — so a retry that clean-exits with a nonempty `publicationTargets` but still carries a
  drift-prefixed `abortReason` is still turned into a blocked verdict instead of being reported as `merged`.
  Nothing after this point calls `runScript` again, so the coordinator makes exactly one merge invocation.

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools`) after making the three edits above.

1. Typecheck the whole project:
   ```
   npx tsc --noEmit
   ```
   Expected: exits 0, no errors reported for `scripts/runMergePhase.ts`, `scripts/mergePipeline.ts`, or
   `scripts/operationBranches.ts`.

2. Confirm every owned file is still under the 250-line cap:
   ```
   wc -l scripts/runMergePhase.ts scripts/mergePipeline.ts scripts/operationBranches.ts
   ```
   Expected: `210 scripts/runMergePhase.ts`, `248 scripts/mergePipeline.ts`, `86 scripts/operationBranches.ts`.

3. Confirm no competing operation-branch prefix remains:
   ```
   rg "tackle-op" scripts/
   ```
   Expected: no matches.

All four smoke tests below identify a merge-script invocation by `cmd[0] === "node"` (the `mergeCommand` passed
in is `["node", "-e", "1"]`) and count it separately from post-rebase test invocations (`cmd[0] === "sh"`), since
`coordinateMergeRetry` calls `deps.runScript` for both purposes and a single undifferentiated counter conflates
them.

4. Behavioral smoke test of the retry coordinator with injected fakes (proves: exactly one initial merge call
   plus exactly one retry call, one post-rebase test invocation, fresh runId, rewritten `operationBranch`,
   refreshed `baseOid`, final verdict "merged"):
   ```
   bun -e '
   import { coordinateMergeRetry } from "./scripts/runMergePhase.ts";
   const mergeCalls: string[][] = [];
   const testCalls: string[][] = [];
   const writes: any[] = [];
   const mergeCommand = ["node", "-e", "1"];
   const runArguments: any = {
     repo: "/repo", typecheckCommand: "x",
     groups: [{ groupId: 1, worktree: "/wt", branch: "b", scope: "unknown", tasks: [] }],
     repositorySources: [{ path: "", sourceBranch: "main" }],
     runId: "old1",
     repositoryManifest: {
       version: 1,
       occurrences: [{
         occurrenceId: "", checkoutPath: "/repo", parentOccurrenceId: null, pathInParent: null,
         gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "aaa",
         operationBranch: "operations/old1/seg", childOccurrenceIds: [], testState: "untested",
       }],
     },
   };
   const deps: any = {
     runScript: (cmd: string[]) => {
       if (cmd[0] === "node") {
         mergeCalls.push(cmd);
         return { exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [{ name: "x" }] }), stderr: "" };
       }
       testCalls.push(cmd);
       return { exitCode: 0, stdout: "", stderr: "" };
     },
     generateRunId: () => "new1",
     readRefOid: () => "bbb",
     writeRunArguments: (data: unknown) => writes.push(data),
     rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
     discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
   };
   const verdict = coordinateMergeRetry(runArguments, mergeCommand, deps);
   console.log(JSON.stringify({
     status: verdict.status,
     mergeInvocations: mergeCalls.length,
     testInvocations: testCalls.length,
     writtenRunId: writes[0]?.runId,
     writtenOperationBranch: writes[0]?.repositoryManifest.occurrences[0].operationBranch,
     writtenBaseOid: writes[0]?.repositoryManifest.occurrences[0].baseOid,
   }));
   '
   ```
   Expected output:
   ```
   {"status":"merged","mergeInvocations":1,"testInvocations":1,"writtenRunId":"new1","writtenOperationBranch":"operations/new1/seg","writtenBaseOid":"bbb"}
   ```

5. Behavioral smoke test of the missing-prefix path (proves: blocked, zero merge invocations — the coordinator
   bails before ever invoking the merge script — and no write):
   ```
   bun -e '
   import { coordinateMergeRetry } from "./scripts/runMergePhase.ts";
   const mergeCalls: string[][] = [];
   const testCalls: string[][] = [];
   const mergeCommand = ["node", "-e", "1"];
   const runArguments: any = {
     repo: "/repo", typecheckCommand: "x",
     groups: [{ groupId: 1, worktree: "/wt", branch: "b", scope: "unknown", tasks: [] }],
     repositorySources: [{ path: "", sourceBranch: "main" }],
     runId: "old1",
     repositoryManifest: {
       version: 1,
       occurrences: [{
         occurrenceId: "", checkoutPath: "/repo", parentOccurrenceId: null, pathInParent: null,
         gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "aaa",
         operationBranch: "tackle-op/old1/seg", childOccurrenceIds: [], testState: "untested",
       }],
     },
   };
   const deps: any = {
     runScript: (cmd: string[]) => {
       if (cmd[0] === "node") {
         mergeCalls.push(cmd);
         return { exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [], abortReason: "the source branch moved past the pinned baseOid (pinned aaa, now bbb)" }), stderr: "" };
       }
       testCalls.push(cmd);
       return { exitCode: 0, stdout: "", stderr: "" };
     },
     generateRunId: () => "new1",
     readRefOid: () => "bbb",
     writeRunArguments: () => { throw new Error("must not write"); },
     rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
     discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
   };
   const verdict = coordinateMergeRetry(runArguments, mergeCommand, deps);
   console.log(JSON.stringify({ status: verdict.status, mergeInvocations: mergeCalls.length, testInvocations: testCalls.length }));
   '
   ```
   Expected output:
   ```
   {"status":"blocked","mergeInvocations":0,"testInvocations":1}
   ```

6. Behavioral smoke test of a retry that exits clean but publishes nothing (proves: blocked via the task-63
   guard, exactly one merge invocation — the single retry — no further attempt):
   ```
   bun -e '
   import { coordinateMergeRetry } from "./scripts/runMergePhase.ts";
   const mergeCalls: string[][] = [];
   const mergeCommand = ["node", "-e", "1"];
   const runArguments: any = {
     repo: "/repo", typecheckCommand: "x",
     groups: [{ groupId: 1, worktree: "/wt", branch: "b", scope: "unknown", tasks: [] }],
     repositorySources: [{ path: "", sourceBranch: "main" }],
     runId: "old1",
     repositoryManifest: {
       version: 1,
       occurrences: [{
         occurrenceId: "", checkoutPath: "/repo", parentOccurrenceId: null, pathInParent: null,
         gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "aaa",
         operationBranch: "operations/old1/seg", childOccurrenceIds: [], testState: "untested",
       }],
     },
   };
   const deps: any = {
     runScript: (cmd: string[]) => {
       if (cmd[0] === "node") {
         mergeCalls.push(cmd);
         return { exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [] }), stderr: "" };
       }
       return { exitCode: 0, stdout: "", stderr: "" };
     },
     generateRunId: () => "new1",
     readRefOid: () => "bbb",
     writeRunArguments: () => {},
     rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
     discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
   };
   const verdict = coordinateMergeRetry(runArguments, mergeCommand, deps);
   console.log(JSON.stringify({ status: verdict.status, mergeInvocations: mergeCalls.length }));
   '
   ```
   Expected output:
   ```
   {"status":"blocked","mergeInvocations":1}
   ```

7. Behavioral smoke test of a retry that hits a second base-drift result — clean exit, nonempty
   `publicationTargets`, but a drift-prefixed `abortReason` (proves: `resultIndicatesBaseDrift` catches this
   independently of `judgeMergeRun`'s own "merged" classification, exactly one merge invocation, no further
   attempt):
   ```
   bun -e '
   import { coordinateMergeRetry } from "./scripts/runMergePhase.ts";
   const mergeCalls: string[][] = [];
   const mergeCommand = ["node", "-e", "1"];
   const runArguments: any = {
     repo: "/repo", typecheckCommand: "x",
     groups: [{ groupId: 1, worktree: "/wt", branch: "b", scope: "unknown", tasks: [] }],
     repositorySources: [{ path: "", sourceBranch: "main" }],
     runId: "old1",
     repositoryManifest: {
       version: 1,
       occurrences: [{
         occurrenceId: "", checkoutPath: "/repo", parentOccurrenceId: null, pathInParent: null,
         gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "aaa",
         operationBranch: "operations/old1/seg", childOccurrenceIds: [], testState: "untested",
       }],
     },
   };
   const deps: any = {
     runScript: (cmd: string[]) => {
       if (cmd[0] === "node") {
         mergeCalls.push(cmd);
         return { exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [{ name: "x" }], abortReason: "the source branch moved past the pinned baseOid (pinned aaa, now ccc)" }), stderr: "" };
       }
       return { exitCode: 0, stdout: "", stderr: "" };
     },
     generateRunId: () => "new1",
     readRefOid: () => "bbb",
     writeRunArguments: () => {},
     rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
     discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
   };
   const verdict = coordinateMergeRetry(runArguments, mergeCommand, deps);
   console.log(JSON.stringify({ status: verdict.status, mergeInvocations: mergeCalls.length }));
   '
   ```
   Expected output:
   ```
   {"status":"blocked","mergeInvocations":1}
   ```
