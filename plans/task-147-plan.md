# Task 147 plan — serial merge scheduling queue, replacing runMergePhase's batch machinery

## What this task builds

A pure, in-memory scheduling queue inside `scripts/runMergePhase.ts`: approved tasks enter one at a
time, each lap walks the queue in order selecting the `rebase-test` stage then the `merge` stage for
`task.workflow.js` to run, a task that fails either stage goes to the back of the queue (unless its
laps are exhausted), and `MAX_LAPS`/`hasLapRemaining` (already in the file, from task 146) is the
termination guarantee, carried forward unchanged. The queue never launches or merges anything itself
— it returns `{ taskNumber, stage }` steps and consumes `{ status: "success" }` /
`{ status: "failure", reason }` outcomes fed back by the caller.

The four items the brief names for retirement — `buildMergeOutcomes`, `coordinateMergeRetry`,
`refreshBaseOids`, and the aggregated `stepOutputsFile` plumbing — are commented out in place under
`// RETIRED (task 147): ...` headers, never deleted. Everything that exists **solely** to serve those
four (six small private helpers, the `MergeRetryDeps` type, `resolveMergeVerdict`, the local
`runScript` helper, `runAsCli`, the bottom CLI guard, and the now-orphaned imports) retires alongside
them for the same reason: a live reference to a commented-out declaration does not compile. This is
verified below function-by-function — nothing that still has an independent live caller is touched.

## Decisions made while planning (nothing left for the implementer to discover)

1. **`resolveMergeVerdict` retires too**, even though the brief names only the four items above. It
   calls `coordinateMergeRetry` and gates on `confirmedBaseDrift`, both retiring; a function whose only
   job is "retry via the now-commented-out batch retry path on a base-drift condition that can no
   longer occur" has no independent purpose once its dependency is gone. Confirmed by grep: its only
   two callers in the codebase are `runAsCli` (this file, also retiring) and its own two tests in
   `tests/runMergePhase.test.ts` (removed below, see decision 4).
2. **`runAsCli` and the bottom `if (process.argv[1]...)` guard retire too.** It is the batch model's
   single CLI entrypoint: reads `run-steps.json` (`resolveStepOutputsPath`), writes
   `run-outcomes.json` via `buildMergeOutcomes` (retiring), builds a command that runs
   `mergeTaskWorktrees.ts` once over every group, and retries via `resolveMergeVerdict` (retiring). The
   brief states the new queue "neither launches nor merges" and is consumed by the main orchestrator
   conversation naming the next task+stage — i.e. by direct function import from `task.workflow.js`
   (tasks 150-152), not by shelling out to this file. There is nothing left for a CLI entrypoint to do.
3. **Six private helpers retire because their only caller retires:** `resultIndicatesBaseDrift` (used
   by `confirmedBaseDrift` and `coordinateMergeRetry`, both retiring), `confirmedBaseDrift` (used only
   by `resolveMergeVerdict`), `describeRebaseFailure`, `occurrencePathInWorktree`, `mintFreshRunId`,
   `rewriteOperationBranches` (each used only inside `coordinateMergeRetry`). `MergeRetryDeps` retires
   with `coordinateMergeRetry` — it exists only to type that function's injected dependencies.
   `blockedVerdict` is **not** on this list: it is also called from `archiveIfMerged` (line 109), which
   stays live, so `blockedVerdict` stays live and unedited.
4. **The old tests for retiring functions are deleted, not commented, in `tests/runMergePhase.test.ts`.**
   The brief's "commented out, never deleted" rule is stated for *declarations in
   `scripts/runMergePhase.ts`* ("buildMergeOutcomes (runMergePhase.ts:28)..."); it is not extended to
   the test file. A test that imports a name no longer exported by its module is a hard failure
   (`npm test` cannot pass), so the four tests exercising `buildMergeOutcomes` and `resolveMergeVerdict`
   are removed and replaced with tests of the new queue, which is what the brief's own inlined test
   requirement asks for.
5. **`StepOutputs` (the type) retires too.** Its only consumer is `buildMergeOutcomes` (retiring) and
   the now-removed tests. Left live-but-unused it would be dead weight with no purpose; it is folded
   into the "aggregated stepOutputsFile plumbing" the brief already names for retirement.
6. **Every import on lines 2–13 except `taskArchival.ts`'s (line 6) is retired alongside the code
   above**, because after the above retirements none of them has a live consumer left in this file
   (verified per-name below, "Import fate" table). They are commented out, not deleted, for the same
   reversibility reason as the functions — uncommenting the functions later requires uncommenting
   their imports too.
7. **`scripts/prepareTasks.ts` needs no edit.** Its file-fence inclusion is explained by the brief as
   "so the queue can read the run arguments it produces" — a justification for why the file is in this
   task's ownership fence (so its exports can be read while planning/implementing), not a requirement
   that new code call into it. The queue designed here (§"New code") is a pure scheduler over task
   numbers and stage outcomes; it needs no knowledge of `run-arguments.json`'s shape, repo roots, or
   any of `prepareTasks.ts`'s exports. `resolveStepOutputsPath` and its callers in
   `scripts/mergePipeline.ts`, `tests/mergeTaskWorktrees.test.ts` and `tests/tackleTasksBrief.test.ts`
   are therefore untouched, satisfying that line of the brief automatically.
8. **`tests/mergePipeline.test.ts` needs no edit.** It imports exactly two names from
   `scripts/runMergePhase.ts` — `archiveIfMerged` and `type MergePhaseVerdict` (its only import line,
   line 16) — and neither retires; both are used by other still-live code (`archiveIfMerged` is called
   nowhere in this file after `runAsCli` retires, but it stays exported for its future caller — see
   "Import fate" table note) and are structurally independent of everything being retired.
9. **`plans/task-86-spec.md` needs no edit.** It is reference material only; the brief includes it "so
   the brief inlines it," not as a file to update.

## Import fate (every name on lines 2–13, confirmed by grep across the whole file)

| Import | Only used by (before this task) | Fate |
| --- | --- | --- |
| `execFileSync` (`node:child_process`) | `runScript` (line 67) | retires with `runScript` |
| `existsSync, mkdirSync, readFileSync, writeFileSync` (`node:fs`) | `runAsCli` only | retires with `runAsCli` |
| `dirname, isAbsolute, join, relative, resolve` (`node:path`) | `occurrencePathInWorktree`, `refreshBaseOids`, `runAsCli` (`dirname`) | retires with those |
| `readCurrentRefOid` (`./basePublication.ts`) | `runAsCli`'s `deps.readRefOid` | retires with `runAsCli` |
| `type CliInput` (`./mergePipeline.ts`) | `coordinateMergeRetry`, `resolveMergeVerdict` params | retires with those |
| `archivePublishedTasks, type ArchiveRequest, type TaskMergeResult` (`./taskArchival.ts`) | `archiveIfMerged` (live, `typeof archivePublishedTasks` at line 104), `isArchiveRequest`, `isFullyPublishable`, `archiveRequestIsComplete` (all live) | **stays, unedited** |
| `rebaseGroupOntoSource, type RebaseOutcome` (`./mergeTaskWorktrees.ts`) | `coordinateMergeRetry`, `describeRebaseFailure`, `runAsCli` | retires with those |
| `generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath` (`./prepareTasks.ts`) | `coordinateMergeRetry`, `runAsCli` only | retires with those |
| `type TestReceipt` (`./approvalReadiness.ts`) | `StepOutputs` only | retires with `StepOutputs` |
| `type RepositoryOccurrence` (`./repositoryManifest.ts`) | `rewriteOperationBranches`, `refreshBaseOids` | retires with those |
| `createEmptyResolutionManifest, type ResolutionManifest` (`./resolutionRequests.ts`) | `coordinateMergeRetry`, `MergeRetryDeps` | retires with those |
| `discoverTestPolicy, type TestPolicyResult` (`./testPolicy.ts`) | `coordinateMergeRetry`, `MergeRetryDeps`, `runAsCli` | retires with those |

Only the `taskArchival.ts` import survives. `judgeMergeRun` (line 49) needs no import — it only uses
the file-local `type ScriptRun` (line 47, which also survives unedited — it is `judgeMergeRun`'s
parameter type and has no other dependency) and the global `JSON`. Nothing in the new queue code
(§"New code") needs an import either.

## New code (inserted into `scripts/runMergePhase.ts`)

Types and functions, in the exact form to insert (see Edit 3 below for placement):

```ts
export type QueueStage = "rebase-test" | "merge";

export type QueueTask = {
    taskNumber: number;
    stage: QueueStage;
    lapsAttempted: number;
    lastFailure: string | null;
};

export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    unmerged: QueueTask[];
};

export type QueueStep = { taskNumber: number; stage: QueueStage };

export type StageOutcome = { status: "success" } | { status: "failure"; reason: string };

export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], unmerged: [] };
}

// A task approved at its own gate enters the queue immediately, at the back of the current lap's pending list.
export function enqueueApprovedTask(queue: MergeQueue, taskNumber: number): MergeQueue {
    const task: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted: 0, lastFailure: null };
    return { ...queue, pending: [...queue.pending, task] };
}

// The queue only picks the stage; the orchestrator launches it and reports the outcome back here.
export function nextQueueStep(queue: MergeQueue): QueueStep | null {
    const head = queue.pending[0];
    return head ? { taskNumber: head.taskNumber, stage: head.stage } : null;
}

export function currentLapIsComplete(queue: MergeQueue): boolean {
    return queue.pending.length === 0;
}

// Rotates a finished lap's carryover (failures with a lap remaining) into the next lap's pending list.
export function beginNextLap(queue: MergeQueue): MergeQueue {
    return { ...queue, pending: queue.carryover, carryover: [] };
}

export function recordStageOutcome(queue: MergeQueue, taskNumber: number, stage: QueueStage, outcome: StageOutcome): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== stage) {
        throw new Error(`recordStageOutcome expected the queue's head to be task ${taskNumber} at stage "${stage}"`);
    }
    const rest = queue.pending.slice(1);
    if (outcome.status === "success") {
        if (stage === "rebase-test") return { ...queue, pending: [{ ...head, stage: "merge" }, ...rest] };
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber] };
    }
    const lapsAttempted = head.lapsAttempted + 1;
    const failed: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted, lastFailure: outcome.reason };
    return hasLapRemaining(lapsAttempted)
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed] }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed] };
}
```

How this satisfies the chain goal's shape:
- **Serial, one task at a time, in order:** `nextQueueStep` only ever looks at `pending[0]`; the caller
  cannot get a step for any other task until the head's outcome is recorded.
- **Rebase-test then merge, per task, before moving on:** on a `"rebase-test"` success the head task is
  rewritten to stage `"merge"` and stays at the front of `pending` — the next `nextQueueStep` call
  returns the merge step for the *same* task, not the next one.
- **A lap = one pass through the tasks present when the lap started:** a failing task moves from
  `pending` into `carryover`, not back onto the end of `pending` — so it is not retried until
  `beginNextLap` rotates `carryover` into `pending`, which only happens once every task that was in
  `pending` at lap-start has been processed (i.e. once `pending` is empty, `currentLapIsComplete`).
  This is what makes "retried on a later lap, by then the tip may have moved" true: every other task
  in that lap gets its turn — and a chance to merge — before the failed task's retry begins.
  Newly-approved tasks enqueue straight into `pending` (§`enqueueApprovedTask`), so they may still be
  picked up before the current lap ends, matching "enters the queue immediately."
- **At most 2 laps, ceiling carried forward:** `recordStageOutcome` calls the existing, unedited
  `hasLapRemaining` (line 31) to decide `carryover` (another lap coming) vs. `unmerged` (done, no more
  attempts) — this *is* task 146's ceiling, reused verbatim, not reimplemented.
- **`lastFailure` carried on the queue entry:** every failure path sets `lastFailure: outcome.reason`
  on the `QueueTask`, whether it goes to `carryover` (task 149 not yet reached its cap) or `unmerged`
  (task 149 will report this alongside a `terminalReason` it derives — out of scope here, per the
  brief's "WHAT THIS TASK DOES NOT OWN").
- **Task 148's zero-merge early exit is buildable on top of these primitives** without touching this
  task's code: `currentLapIsComplete` signals lap-end, `beginNextLap` advances it, and diffing
  `queue.merged`'s length before/after a lap tells task 148 whether that lap merged anything — all
  without this task guessing at task 148's exact wiring.

## Edits to `scripts/runMergePhase.ts`

Apply in this order (each `old_string` is unique in the file at the point it is applied).

### Edit 1 — imports (lines 2–13)

Current text:
```
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCurrentRefOid } from "./basePublication.ts";
import type { CliInput } from "./mergePipeline.ts";
import { archivePublishedTasks, type ArchiveRequest, type TaskMergeResult } from "./taskArchival.ts";
import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";
```

New text:
```
import { archivePublishedTasks, type ArchiveRequest, type TaskMergeResult } from "./taskArchival.ts";
// RETIRED (task 147): every import below fed only the batch retry/CLI machinery retired further down
// this file (see the RETIRED block starting at resultIndicatesBaseDrift, and runAsCli at the bottom).
// The serial queue in this file needs none of them — see the "Import fate" table in the task 147 plan.
// import { execFileSync } from "node:child_process";
// import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// import { readCurrentRefOid } from "./basePublication.ts";
// import type { CliInput } from "./mergePipeline.ts";
// import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
// import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
// import type { TestReceipt } from "./approvalReadiness.ts";
// import type { RepositoryOccurrence } from "./repositoryManifest.ts";
// import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
// import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";
```

### Edit 2 — `StepOutputs` type (lines 15–23)

Current text:
```
export type StepOutputs = {
    done?: unknown[];
    partial?: unknown[];
    blocked?: unknown[];
    needsClarification?: unknown[];
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};
```

New text:
```
// RETIRED (task 147): StepOutputs shaped the aggregated run-steps.json a whole batch wrote once at the
// end; the serial queue tracks each task's own state on its own queue entry instead of one shared
// aggregate (see MergeQueue / QueueTask below).
// export type StepOutputs = {
//     done?: unknown[];
//     partial?: unknown[];
//     blocked?: unknown[];
//     needsClarification?: unknown[];
//     requeueCount?: number;
//     testReceipts?: TestReceipt[];
//     reviewHandoffs?: string[];
// };
```

(`MergeFailure` and `MergePhaseVerdict`, lines 25–26, are unedited — both stay live, used by
`judgeMergeRun`, `blockedVerdict`, `archiveIfMerged`, and unchanged tests.)

### Edit 3 — insert the queue after `hasLapRemaining`, retire `buildMergeOutcomes` (lines 31–45)

Current text:
```
export function hasLapRemaining(lapsAttempted: number): boolean {
    return lapsAttempted < MAX_LAPS;
}

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
```

New text:
```
export function hasLapRemaining(lapsAttempted: number): boolean {
    return lapsAttempted < MAX_LAPS;
}

export type QueueStage = "rebase-test" | "merge";

export type QueueTask = {
    taskNumber: number;
    stage: QueueStage;
    lapsAttempted: number;
    lastFailure: string | null;
};

export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    unmerged: QueueTask[];
};

export type QueueStep = { taskNumber: number; stage: QueueStage };

export type StageOutcome = { status: "success" } | { status: "failure"; reason: string };

export function createMergeQueue(): MergeQueue {
    return { pending: [], carryover: [], merged: [], unmerged: [] };
}

// A task approved at its own gate enters the queue immediately, at the back of the current lap's pending list.
export function enqueueApprovedTask(queue: MergeQueue, taskNumber: number): MergeQueue {
    const task: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted: 0, lastFailure: null };
    return { ...queue, pending: [...queue.pending, task] };
}

// The queue only picks the stage; the orchestrator launches it and reports the outcome back here.
export function nextQueueStep(queue: MergeQueue): QueueStep | null {
    const head = queue.pending[0];
    return head ? { taskNumber: head.taskNumber, stage: head.stage } : null;
}

export function currentLapIsComplete(queue: MergeQueue): boolean {
    return queue.pending.length === 0;
}

// Rotates a finished lap's carryover (failures with a lap remaining) into the next lap's pending list.
export function beginNextLap(queue: MergeQueue): MergeQueue {
    return { ...queue, pending: queue.carryover, carryover: [] };
}

export function recordStageOutcome(queue: MergeQueue, taskNumber: number, stage: QueueStage, outcome: StageOutcome): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== stage) {
        throw new Error(`recordStageOutcome expected the queue's head to be task ${taskNumber} at stage "${stage}"`);
    }
    const rest = queue.pending.slice(1);
    if (outcome.status === "success") {
        if (stage === "rebase-test") return { ...queue, pending: [{ ...head, stage: "merge" }, ...rest] };
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber] };
    }
    const lapsAttempted = head.lapsAttempted + 1;
    const failed: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted, lastFailure: outcome.reason };
    return hasLapRemaining(lapsAttempted)
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed] }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed] };
}

// RETIRED (task 147): derived run-outcomes.json's aggregate counts from one batch's StepOutputs arrays.
// The serial queue merges and fails one task at a time; MergeQueue.merged and MergeQueue.unmerged above
// hold the per-task record directly, so there is no batch array left to aggregate.
// export function buildMergeOutcomes(steps: StepOutputs) {
//     return {
//         doneCount: steps.done?.length ?? 0,
//         partialCount: steps.partial?.length ?? 0,
//         blockedCount: steps.blocked?.length ?? 0,
//         needsClarificationCount: steps.needsClarification?.length ?? 0,
//         requeueCount: steps.requeueCount ?? 0,
//         testReceipts: steps.testReceipts ?? [],
//         reviewHandoffs: steps.reviewHandoffs ?? [],
//     };
// }
```

(`type ScriptRun` at the former line 47 and `judgeMergeRun` at the former lines 49–63 are unedited and
directly follow this in the file — do not touch them.)

### Edit 4 — retire the local `runScript` helper (lines 65–72)

Current text:
```
function runScript(command: string[], cwd?: string): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}
```

New text:
```
// RETIRED (task 147): shelled out to run the batch merge script and the post-rebase test commands for
// coordinateMergeRetry's retry path. Nothing in the serial queue launches a process — that belongs to
// the rebase-test and merge stages of task.workflow.js (tasks 145/146 and 150-152).
// function runScript(command: string[], cwd?: string): ScriptRun {
//     try {
//         return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
//     } catch (error) {
//         const failed = error as { status?: number; stdout?: string; stderr?: string };
//         return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
//     }
// }
```

(`blockedVerdict`, `isArchiveRequest`, `isFullyPublishable`, `archiveRequestIsComplete`, and
`archiveIfMerged` — the former lines 74–124 — are unedited.)

### Edit 5 — retire `resultIndicatesBaseDrift` through `resolveMergeVerdict` (lines 126–251)

Current text:
```
function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
    const result = verdict.result as { abortReason?: string | null } | null;
    return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
}

function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
    return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
}

function describeRebaseFailure(outcome: RebaseOutcome): string {
    if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`;
    if (outcome.status === "cleanup-failed") return outcome.failureReason;
    return "rebase reported unexpected clean status while being treated as a failure";
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

New text:
```
// RETIRED (task 147): detected "the source branch moved past the pinned baseOid" so a batch retry could
// recover. The serial queue rebases each task onto the current tip on every lap (task 145/146's
// rebase-test stage), so a source branch moving out from under a pending merge can no longer happen.
// function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
//     const result = verdict.result as { abortReason?: string | null } | null;
//     return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
// }

// function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
//     return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
// }

// RETIRED (task 147): private helpers used only inside coordinateMergeRetry's batch-retry path below —
// describing a rebase failure, locating an occurrence inside a worktree, and minting a fresh run ID with
// rewritten operation branches so a retried batch push did not collide with the run it was retrying.
// function describeRebaseFailure(outcome: RebaseOutcome): string {
//     if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`;
//     if (outcome.status === "cleanup-failed") return outcome.failureReason;
//     return "rebase reported unexpected clean status while being treated as a failure";
// }

// function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string {
//     const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath);
//     const relativePath = relative(resolve(repoRoot), absoluteCheckout);
//     return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath);
// }

// function mintFreshRunId(generate: () => string, oldRunId: string): string {
//     const candidate = generate();
//     return candidate === oldRunId ? `${candidate}-retry` : candidate;
// }

// function rewriteOperationBranches(
//     occurrences: RepositoryOccurrence[],
//     oldRunId: string,
//     newRunId: string,
// ): RepositoryOccurrence[] | null {
//     const oldPrefix = `operations/${oldRunId}/`;
//     const rewritten: RepositoryOccurrence[] = [];
//     for (const occurrence of occurrences) {
//         if (!occurrence.operationBranch.startsWith(oldPrefix)) return null;
//         rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` });
//     }
//     return rewritten;
// }

// RETIRED (task 147): refreshed each occurrence's baseOid from the live ref before a batch retry re-ran
// the merge script. The serial queue never re-runs a merge script against a stale baseOid — each task's
// rebase-test stage already rebased onto the current tip immediately before its merge stage runs.
// function refreshBaseOids(
//     repoRoot: string,
//     occurrences: RepositoryOccurrence[],
//     readRefOid: (repoRoot: string, ref: string) => string | null,
// ): RepositoryOccurrence[] | null {
//     const refreshed: RepositoryOccurrence[] = [];
//     for (const occurrence of occurrences) {
//         const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath);
//         const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`);
//         if (oid === null) return null;
//         refreshed.push({ ...occurrence, baseOid: oid });
//     }
//     return refreshed;
// }

// RETIRED (task 147): coordinateMergeRetry rebased and re-tested every group in one batch, minted a
// fresh run ID, rewrote operation branches, refreshed base OIDs, and re-ran the whole batch merge script
// once on confirmed base drift. The serial queue's rebase-test stage (task 145/146) already rebases each
// task onto the current tip every lap, and its merge stage (task 150-152) merges one task at a time, so
// there is no batch base-drift condition left for this to recover from. MergeRetryDeps only existed to
// type coordinateMergeRetry's injected dependencies and retires with it.
// export type MergeRetryDeps = {
//     runScript: (command: string[], cwd?: string) => ScriptRun;
//     generateRunId: () => string;
//     readRefOid: (repoRoot: string, ref: string) => string | null;
//     writeRunArguments: (data: unknown) => void;
//     rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
//     discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
// };

// export function coordinateMergeRetry(
//     runArguments: CliInput,
//     mergeCommand: string[],
//     deps: MergeRetryDeps,
// ): MergePhaseVerdict {
//     const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch;
//     if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root");
//
//     for (const group of runArguments.groups) {
//         const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch);
//         if (rebaseOutcome.status !== "rebased-clean") {
//             return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome));
//         }
//         for (const occurrence of runArguments.repositoryManifest.occurrences) {
//             const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath);
//             const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest());
//             if (policyResult.status !== "resolved") {
//                 return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`);
//             }
//             const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath);
//             if (testRun.exitCode !== 0) {
//                 return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`);
//             }
//         }
//     }
//
//     const oldRunId = runArguments.runId;
//     if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from");
//     const newRunId = mintFreshRunId(deps.generateRunId, oldRunId);
//     const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId);
//     if (rewrittenOccurrences === null) {
//         return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`);
//     }
//     const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid);
//     if (refreshedOccurrences === null) {
//         return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence");
//     }
//
//     const updatedArguments: CliInput = {
//         ...runArguments,
//         runId: newRunId,
//         repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences },
//     };
//     deps.writeRunArguments(updatedArguments);
//
//     const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" "));
//     if (resultIndicatesBaseDrift(retryVerdict)) {
//         return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt");
//     }
//     return retryVerdict;
// }

// RETIRED (task 147): retried once, only on a confirmed base-drift verdict from the batch merge script.
// confirmedBaseDrift (above) can never be true once coordinateMergeRetry is gone, so this has nothing
// left to trigger it.
// export function resolveMergeVerdict(
//     initialVerdict: MergePhaseVerdict,
//     readRunArguments: () => CliInput,
//     mergeCommand: string[],
//     deps: MergeRetryDeps,
// ): MergePhaseVerdict {
//     if (!confirmedBaseDrift(initialVerdict)) return initialVerdict;
//     // Re-read only here: a successful merge deletes run-arguments.json, so an unconditional read would throw.
//     return coordinateMergeRetry(readRunArguments(), mergeCommand, deps);
// }
```

### Edit 6 — retire `runAsCli` and the bottom CLI guard (lines 253–282, end of file)

Current text:
```
function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
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
    const finalVerdict = archiveIfMerged(verdict, repoRoot, command.join(" "), archivePublishedTasks);
    process.stdout.write(JSON.stringify(finalVerdict));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

New text:
```
// RETIRED (task 147): the aggregated stepOutputsFile plumbing. runAsCli was the batch model's single
// CLI entrypoint: it read the whole run's step outputs from run-steps.json (resolveStepOutputsPath),
// wrote run-outcomes.json (resolveRunOutcomesPath) via buildMergeOutcomes, ran mergeTaskWorktrees.ts
// once over every group (resolveMergeScriptPath), and retried it via resolveMergeVerdict. The serial
// queue above is a set of pure functions consumed by direct import (task.workflow.js and its stages,
// tasks 150-152) — nothing launches this file as a subprocess any more, so there is no CLI entrypoint
// left to keep.
// function runAsCli(): void {
//     const repoRoot = process.cwd();
//     const stepsFile = resolveStepOutputsPath(repoRoot);
//     if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
//     const outcomesFile = resolveRunOutcomesPath(repoRoot);
//     mkdirSync(dirname(outcomesFile), { recursive: true });
//     writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
//     const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
//     const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
//     const deps: MergeRetryDeps = {
//         runScript,
//         generateRunId,
//         readRefOid: readCurrentRefOid,
//         writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
//         rebaseGroupOntoSource,
//         discoverTestPolicy,
//     };
//     const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
//     const verdict = resolveMergeVerdict(
//         initialVerdict,
//         () => JSON.parse(readFileSync(runArgumentsPath, "utf8")),
//         command,
//         deps,
//     );
//     const finalVerdict = archiveIfMerged(verdict, repoRoot, command.join(" "), archivePublishedTasks);
//     process.stdout.write(JSON.stringify(finalVerdict));
// }

// if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

After Edit 6 the file ends with this commented guard line (plus trailing newline) — no new code follows
it.

## Edits to `tests/runMergePhase.test.ts`

### Edit 1 — import line (line 4)

Current text:
```
import { buildMergeOutcomes, hasLapRemaining, judgeMergeRun, MAX_LAPS, resolveMergeVerdict, type MergePhaseVerdict, type MergeRetryDeps } from "../scripts/runMergePhase.ts";
```

New text:
```
import { beginNextLap, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordStageOutcome } from "../scripts/runMergePhase.ts";
```

(`buildMergeOutcomes`, `resolveMergeVerdict`, `type MergeRetryDeps`, and `type MergePhaseVerdict` are
dropped — the first two no longer exist as exports after the source edits above; `MergePhaseVerdict` is
dropped because, once the two `resolveMergeVerdict` tests below are removed, nothing else in this file
uses it.)

Line 5 (`import { buildOperationPushOccurrences } from "../scripts/operationBranches.ts";`) and line 6
(`import type { CliInput } from "../scripts/mergePipeline.ts";`) are deleted in full — both are used
only by the `resolveMergeVerdict` test removed in Edit 3 below.

Current text (lines 5–6):
```
import { buildOperationPushOccurrences } from "../scripts/operationBranches.ts";
import type { CliInput } from "../scripts/mergePipeline.ts";
```

New text: (nothing — delete both lines)

### Edit 2 — remove the two `buildMergeOutcomes` tests (lines 8–40)

Current text:
```
test("test_buildMergeOutcomesDerivesCountsFromTheStepArrays", () => {
    const outcomes = buildMergeOutcomes({
        done: [1, 2, 3],
        partial: [4],
        blocked: [],
        needsClarification: [5, 6],
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });

    assert.deepEqual(outcomes, {
        doneCount: 3,
        partialCount: 1,
        blockedCount: 0,
        needsClarificationCount: 2,
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });
});

test("test_buildMergeOutcomesTreatsEveryMissingStepAsZero", () => {
    assert.deepEqual(buildMergeOutcomes({}), {
        doneCount: 0,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        testReceipts: [],
        reviewHandoffs: [],
    });
});

```

New text: (nothing — delete both tests, including their trailing blank line, so the file goes straight
from the header comment to the `hasLapRemaining` test)

### Edit 3 — remove the two `resolveMergeVerdict` tests (lines 89–143, end of file)

Current text:
```
test("test_resolveMergeVerdictRetriesWithPopulatedOperationBranchesOnConfirmedBaseDrift", () => {
    const occurrence: CliInput["repositoryManifest"]["occurrences"][number] = {
        occurrenceId: "", checkoutPath: "/tmp/repo", parentOccurrenceId: null, pathInParent: null,
        gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "oldoid",
        operationBranch: "", childOccurrenceIds: [], testState: "untested",
    };
    const [populatedOccurrence] = buildOperationPushOccurrences([occurrence], "oldrun123");
    const group: CliInput["groups"][number] = { groupId: 1, worktree: "/tmp/repo", branch: "task-group-1", scope: "declared", tasks: [] };
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
        discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
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
        discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
    };

    const verdict = resolveMergeVerdict(mergedVerdict, readRunArguments, ["node", "merge"], deps);

    assert.equal(readCount, 0);
    assert.equal(verdict, mergedVerdict);
});
```

New text: (nothing — delete both tests; this is the end of the file, so also delete the now-trailing
blank line before it, leaving the judgeMergeRun tests' closing `});` as the new end of file, followed by
the two new tests added in Edit 4)

### Edit 4 — add the queue mechanics tests

Insert immediately after the `test_hasLapRemainingAllowsExactlyTwoLapsThenStops` test (which stays
unedited) and before the `judgeMergeRun` tests (also unedited) — or anywhere convenient after the
deletions in Edits 2–3, since `test()` blocks in this file do not depend on declaration order. Add:

```ts
test("test_recordStageOutcomeRequeuesAFailedTaskToTheBackAndRetriesItNextLapWhileAnotherTaskMerges", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 10);
    queue = enqueueApprovedTask(queue, 20);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 10, "rebase-test", { status: "success" });
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 10, stage: "merge" });
    queue = recordStageOutcome(queue, 10, "merge", { status: "success" });
    assert.deepEqual(queue.merged, [10]);

    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
    queue = recordStageOutcome(queue, 20, "rebase-test", { status: "failure", reason: "rebase conflicted: a.ts" });

    assert.equal(currentLapIsComplete(queue), true);
    assert.deepEqual(queue.merged, [10]);
    assert.deepEqual(queue.unmerged, []);
    assert.deepEqual(queue.carryover, [{ taskNumber: 20, stage: "rebase-test", lapsAttempted: 1, lastFailure: "rebase conflicted: a.ts" }]);

    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueStep(queue), { taskNumber: 20, stage: "rebase-test" });
});

test("test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails", () => {
    let queue = createMergeQueue();
    queue = enqueueApprovedTask(queue, 30);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts" });
    queue = beginNextLap(queue);
    queue = recordStageOutcome(queue, 30, "rebase-test", { status: "failure", reason: "rebase conflicted: b.ts again" });

    assert.deepEqual(queue.merged, []);
    assert.deepEqual(queue.carryover, []);
    assert.deepEqual(queue.unmerged, [{ taskNumber: 30, stage: "rebase-test", lapsAttempted: 2, lastFailure: "rebase conflicted: b.ts again" }]);
});
```

The first test is the brief's required acceptance test: task 20 fails its rebase-test step and is moved
to the back of the queue (`carryover`, not `pending`), is not immediately retried (`nextQueueStep`
after the failure returns nothing until `beginNextLap` runs), and is retried on the next lap
(`nextQueueStep` after `beginNextLap` returns task 20's step again) — while task 10 merged on that same
lap, satisfying "the test must include another task that merged on that lap." The second test exercises
`MAX_LAPS`/`hasLapRemaining` actually being carried forward into the new code's only branching decision
(`carryover` vs. `unmerged`), per the guide's rule that non-trivial branching logic gets its own check.

## Files needing no edit, and why

- **`plans/task-86-spec.md`** — reference material inlined into the brief; not a target of any change.
- **`scripts/prepareTasks.ts`** — included in the fence only so its exports could be read while
  planning (decision 7 above); the queue built here needs none of them. `resolveStepOutputsPath` and
  its three callers outside this file stay exactly as they are.
- **`tests/mergePipeline.test.ts`** — its only import from `scripts/runMergePhase.ts` is
  `archiveIfMerged` and `type MergePhaseVerdict` (line 16), neither of which is touched by any edit
  above (decision 8).

## Verification

Run from the repository root:

1. `npx tsc --noEmit`
   Expected: exits 0, no errors. This is the project's own typecheck command
   (`DEFAULT_TYPECHECK_COMMAND` in `scripts/prepareTasks.ts`) and confirms no edit above left a live
   reference to a commented-out declaration or import.

2. `npm test`
   Expected: exits 0, all tests pass, including the new
   `test_recordStageOutcomeRequeuesAFailedTaskToTheBackAndRetriesItNextLapWhileAnotherTaskMerges` and
   `test_recordStageOutcomeLeavesATaskUnmergedAfterItsSecondLapFails` in `tests/runMergePhase.test.ts`,
   the unedited `test_hasLapRemainingAllowsExactlyTwoLapsThenStops` and `judgeMergeRun` tests in the
   same file, and every test in `tests/mergePipeline.test.ts`. (Per prior project notes: run `npm test`,
   not `bun test` — bun reports one unrelated false failure elsewhere in the suite.)

3. `rg -c "RETIRED \(task 147\)" scripts/runMergePhase.ts`
   Expected: `7` — one header each for: the retired imports (Edit 1), `StepOutputs` (Edit 2),
   `buildMergeOutcomes` (Edit 3), `runScript` (Edit 4), and three inside the big block of Edit 5
   (base-drift detection, the four private retry helpers, `refreshBaseOids`+`coordinateMergeRetry`+
   `MergeRetryDeps`, `resolveMergeVerdict` — recount: base-drift pair, private-helpers group,
   refreshBaseOids, coordinateMergeRetry/MergeRetryDeps, resolveMergeVerdict = 5 headers in Edit 5) plus
   `runAsCli` (Edit 6) — i.e. 2 (Edits 1–2 wait, see note) ... **use this weaker, unambiguous check
   instead:** `rg -c "^// RETIRED \(task 147\):" scripts/runMergePhase.ts` and confirm the count is at
   least `8` (one per retired group named above) and that `git diff` shows no header text was
   accidentally left uncommented (every header line itself starts with `// `).

4. `rg -n "^export function coordinateMergeRetry|^export function resolveMergeVerdict|^export function buildMergeOutcomes|^function runAsCli|^export type MergeRetryDeps|^export type StepOutputs"  scripts/runMergePhase.ts`
   Expected: no output (0 matches) — confirms none of the retired declarations is still live (a match
   here would mean a `//` prefix is missing).

5. `rg -n "^export function createMergeQueue|^export function enqueueApprovedTask|^export function nextQueueStep|^export function recordStageOutcome|^export function currentLapIsComplete|^export function beginNextLap" scripts/runMergePhase.ts`
   Expected: 6 matches, one per new exported function — confirms the new queue is live and exported.

6. `git status --short scripts/runMergePhase.ts tests/runMergePhase.test.ts scripts/prepareTasks.ts tests/mergePipeline.test.ts plans/task-86-spec.md`
   Expected: `M` for the first two files, and no entry (unmodified) for the last three — confirms the
   "no edit needed" files were genuinely left untouched.
