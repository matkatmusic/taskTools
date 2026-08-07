# Task 111: Populate operationBranch before any merge attempt so the base-drift auto-retry can actually run

## User request

The base-drift auto-retry in scripts/runMergePhase.ts can never succeed on a first drift, because rewriteOperationBranches fail-closes on an operationBranch that was never populated. Repro from run msj8czjj-r3odjv8prf8 on 2026-08-07: the merge phase returned blocked with error 'an occurrence operationBranch does not carry the expected prefix "operations/msj8czjj-r3odjv8prf8/"'. Chain of causes, all verified in source: prepareTasks.ts (and repositoryDiscovery.ts) initialize every occurrence's operationBranch to the empty string when writing .taskTools/run-arguments.json. mergePipeline.ts never persists a real operationBranch back into that file - operationBranches.ts recomputes branch names from runId plus occurrenceId in memory on every invocation and never reads the persisted field back. coordinateMergeRetry at runMergePhase.ts lines 160-166 calls rewriteOperationBranches, which returns null the moment any occurrence's operationBranch does not start with operations/{oldRunId}/, and a null return becomes a blockedVerdict. Therefore on any run that hits base drift before a successful push - which is exactly the first-drift case - operationBranch is still the empty string and the retry is guaranteed to block. Note the earlier steps of coordinateMergeRetry do work: rebaseGroupOntoSource rebased the group cleanly and the post-rebase suite passed before the guard rejected it. plans/task-91-plan.md shows the fail-closed guard was a deliberate design decision from a prior review pass, so this is a design gap to close rather than a typo to patch. Three candidate fixes were identified and the choice is open: (1) let rewriteOperationBranches pass an empty or never-assigned operationBranch through unchanged so first-drift retries proceed, which loosens the deliberate guard; (2) keep the guard and accept manual out-of-band retry, which is what was done to land task 77; (3) fix it upstream so prepareTasks.ts / repositoryDiscovery.ts populate a real operationBranch before any merge attempt, making the guard's invariant actually true. Option 3 looks the most correct because it makes the guard honest instead of weakening it. Files likely involved: scripts/runMergePhase.ts, scripts/prepareTasks.ts, scripts/repositoryDiscovery.ts, scripts/operationBranches.ts, scripts/mergePipeline.ts, tests/runMergePhase.test.ts. Impact: every tackle-tasks run whose base branch moves mid-run - common when a second session is committing - blocks at merge and needs a hand merge.

Live repro captured on 2026-08-07 during the tackle-tasks run for task 77 (runId msj8czjj-r3odjv8prf8). The merge phase printed {"status":"blocked","failure":{...,"error":"an occurrence operationBranch does not carry the expected prefix \"operations/msj8czjj-r3odjv8prf8/\""}} and task 77 had to be landed with a hand fast-forward instead.\n\nCall chain, each link read in source rather than inferred:\n- scripts/runMergePhase.ts:194 reads .taskTools/run-arguments.json into runArguments once, before the merge script runs at line 204. It never re-reads that file, so any operationBranch the merge script may have written to disk is invisible to the retry path.\n- scripts/runMergePhase.ts:205 routes to coordinateMergeRetry only when confirmedBaseDrift(initialVerdict).\n- Inside coordinateMergeRetry the earlier steps succeed: line 143 rebaseGroupOntoSource returned rebased-clean, and lines 147-156 resolved the test policy and ran the complete suite green. Verified directly: after the blocked verdict, branch task-group-1 was already sitting rebased on top of the source branch.\n- scripts/runMergePhase.ts:163-166 then calls rewriteOperationBranches, which returns null unless every occurrence's operationBranch starts with `operations/{oldRunId}/`; a null return is converted to blockedVerdict.\n- scripts/prepareTasks.ts:210-223 builds pipelineArguments from loadRepositoryManifest(repoRoot) and writes it straight to .taskTools/run-arguments.json with operationBranch still the empty string. Confirmed on disk during the repro: the sole root occurrence had operationBranch == \"\".\n- scripts/operationBranches.ts recomputes branch names from runId plus occurrenceId in memory on each invocation (setUpOperationBranches / buildOperationPushOccurrences) and never reads the persisted field, so scripts/mergePipeline.ts never persists one back.\n\nConsequence: on a first-ever base drift, operationBranch is guaranteed to still be the empty string, so the guard always fires and the automatic retry can never complete. This is not rare - it triggers whenever a second session commits to the source branch mid-run, which is what happened here (recorded baseOid cd39a178, source branch had advanced three commits).\n\nConstraint: plans/task-91-plan.md records the fail-closed guard as a deliberate decision from a prior review pass ('returns null -> blocked, zero further merge-script invocations, the moment one occurrence's operationBranch does not start with operations/{oldRunId}/'). Two independent diagnosis passes reached the same three options; option 3 (populate a real operationBranch upstream in prepareTasks.ts / repositoryDiscovery.ts so the guard's invariant is actually true) is preferred because it makes the guard honest rather than weakening it. Beware the two competing naming schemes already in the codebase: mergePipeline.ts writes operations/{runId}/{sanitizeSegment(logicalId)} while operationBranches.ts uses tackle-op/{runId}/...; the guard checks the operations/ form.\n\nSecond-order defect worth handling in the same change: runMergePhase.ts holds a stale in-memory copy of run-arguments.json across the merge invocation, so even a merge script that did persist operationBranch would not help the retry.

### scripts/runMergePhase.ts

```
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

### scripts/prepareTasks.ts

```
// Writes task briefs, creates one worktree per file-disjoint group, prints WorkflowArguments. CLI entry point at bottom.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "./repositoryManifest.ts";
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
import { groupTasksByFileOverlap } from "./taskGroups.ts";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
};

export type PreparedGroup = {
    groupId: number;
    worktree: string;
    branch: string;
    scope: TaskGroupScope;
    tasks: PreparedTask[];
};

export type WorkflowArguments = {
    repo: string;
    typecheckCommand: string;
    groups: PreparedGroup[];
    repositorySources: RepositorySource[];
};

const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";

function getOpenBlockers(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map((entry) => entry.taskNum).filter((number) => openNumbers.has(number));
}

// Never defaults to every open task: this creates worktrees and fans out agents.
export function selectRequestedTasks(openTasks: TaskRecord[], requestedNumbers: number[]): TaskRecord[] {
    if (requestedNumbers.length === 0) {
        throw new Error("no task numbers given; pass a JSON array with no spaces, e.g. [268,270]");
    }
    const openNumbers = new Set(openTasks.map((task) => task.taskNumber));
    const missingNumbers = requestedNumbers.filter((number) => !openNumbers.has(number));
    if (missingNumbers.length > 0) {
        throw new Error(`not open in tasks.json: ${missingNumbers.join(", ")}`);
    }
    const requestedTasks = openTasks.filter((task) => requestedNumbers.includes(task.taskNumber));
    const runnableTasks = requestedTasks.filter((task) => getOpenBlockers(task, openNumbers).length === 0);
    const undeclaredNumbers = runnableTasks.filter((task) => declaredFiles(task).length === 0).map((task) => task.taskNumber);
    if (undeclaredNumbers.length > 0) {
        const numbers = undeclaredNumbers.join(", ");
        throw new Error(
            `these tasks declare no "files" and cannot be planned or implemented: ${numbers}. `
            + `A task's "files" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
    }
    return runnableTasks;
}

export function generateRunId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function resolveMergeScriptPath(): string {
    return join(import.meta.dirname, "mergeTaskWorktrees.ts");
}

// The merge script reads its bulky arguments from here so no agent has to retype them.
export function resolveRunArgumentsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-arguments.json");
}

// Step 6 writes the run's outcome counts and receipts here rather than shell-quoting them.
export function resolveRunOutcomesPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-outcomes.json");
}

// Step 6 drops the earlier steps' return values here verbatim; runMergePhase.ts derives the counts.
export function resolveStepOutputsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-steps.json");
}

export function resolveMergePhaseScriptPath(): string {
    return join(import.meta.dirname, "runMergePhase.ts");
}

function branchNameForGroup(groupId: number): string {
    return `task-group-${groupId}`;
}

function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const fileSections = declaredFiles(task).map((file) => {
        const fullPath = join(repoRoot, file);
        if (!existsSync(fullPath)) return `### ${file}\n\n(missing: file not found on disk)\n`;
        return `### ${file}\n\n\`\`\`\n${readFileSync(fullPath, "utf8")}\n\`\`\`\n`;
    });
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}

// `git worktree add` leaves submodule directories empty; a worker needs them populated.
function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `group-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        execFileSync(
            "git",
            ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "HEAD"],
            { stdio: "ignore" },
        );
    }
    initializeSubmodulesInWorktree(worktreePath);
    createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName);
    return worktreePath;
}

export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}

function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
    const result = bootstrapRepositoryManifest(repoRoot);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function hasOriginRemote(repoRoot: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        if (!hasOriginRemote(repoRoot)) {
            throw new Error("this repository does not have an origin remote. set one to continue to use 'tackle-tasks'");
        }
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
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
    const argumentsFile = resolveRunArgumentsPath(repoRoot);
    mkdirSync(dirname(argumentsFile), { recursive: true });
    writeFileSync(argumentsFile, JSON.stringify(pipelineArguments));
    process.stdout.write(JSON.stringify({
        ...pipelineArguments,
        stepOutputsFile: resolveStepOutputsPath(repoRoot),
        mergeCommand: `node "${resolveMergePhaseScriptPath()}"`,
    }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/repositoryDiscovery.ts

```
// Root-outward discovery of a repository's nested submodule tree, gated on full branch resolution.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { resolveBaseBranchCandidates } from "./baseBranchResolution.ts";
import {
    createResolutionRequest,
    createResolutionRequestId,
    hasResolutionAnswer,
    recordResolutionRequest,
    REASON_MULTIPLE_EXACT_TIP_MATCHES,
    REASON_ZERO_EXACT_TIP_MATCHES,
} from "./resolutionRequests.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";

export type DiscoveryManifest = {
    repositoryManifest: RepositoryManifest;
    resolutionManifest: ResolutionManifest;
};

export type DiscoveryResult =
    | { status: "resolved"; graph: RepositoryOccurrence[] }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };

function readOriginUrl(checkoutPath: string): string {
    try {
        return execFileSync("git", ["-C", checkoutPath, "remote", "get-url", "origin"], {
            encoding: "utf8",
        }).trim();
    } catch {
        // No remote: the root commit identifies the repo across every checkout of it.
        return `rootcommit:${execFileSync("git", ["-C", checkoutPath, "rev-list", "--max-parents=0", "HEAD"], {
            encoding: "utf8",
        }).trim()}`;
    }
}

function readRootBranchAndOid(rootPath: string): { branch: string; oid: string } {
    let branch: string;
    try {
        branch = execFileSync("git", ["-C", rootPath, "symbolic-ref", "--short", "HEAD"], {
            encoding: "utf8",
        }).trim();
    } catch {
        throw new Error(`root repository at "${rootPath}" is not on a branch (detached HEAD)`);
    }
    const oid = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { branch, oid };
}

function resolveOccurrenceBaseBranch(
    checkoutPath: string,
    occurrenceId: string,
    baseOid: string,
    resolutionManifest: ResolutionManifest,
    pendingResolutionRequests: ResolutionRequest[],
): string {
    const resolution = resolveBaseBranchCandidates(checkoutPath, baseOid);
    if (resolution.kind === "single") return resolution.baseBranch;

    const reason = resolution.kind === "none" ? REASON_ZERO_EXACT_TIP_MATCHES : REASON_MULTIPLE_EXACT_TIP_MATCHES;
    const requestId = createResolutionRequestId(occurrenceId, reason);
    if (hasResolutionAnswer(resolutionManifest, requestId)) {
        return resolutionManifest.resolutionAnswers[requestId];
    }

    const request = createResolutionRequest(occurrenceId, baseOid, resolution.candidates, reason);
    recordResolutionRequest(resolutionManifest, request);
    pendingResolutionRequests.push(request);
    return "";
}

function discoverOccurrenceAndDescendants(
    rootPath: string,
    relativePath: string,
    parentOccurrenceId: string | null,
    pathInParent: string | null,
    depth: number,
    gitlinkOid: string,
    manifest: DiscoveryManifest,
    pendingResolutionRequests: ResolutionRequest[],
): void {
    const occurrenceId = relativePath;
    const checkoutPath = join(rootPath, relativePath);
    const occurrences = manifest.repositoryManifest.occurrences;
    const existing = occurrences.find((candidate) => candidate.occurrenceId === occurrenceId);

    let baseOid = gitlinkOid;
    let baseBranch: string;

    if (existing && existing.baseBranch !== "") {
        baseOid = existing.baseOid;
        baseBranch = existing.baseBranch;
    } else if (parentOccurrenceId === null) {
        const rootIdentity = readRootBranchAndOid(rootPath);
        baseOid = rootIdentity.oid;
        baseBranch = rootIdentity.branch;
    } else {
        baseBranch = resolveOccurrenceBaseBranch(
            checkoutPath,
            occurrenceId,
            baseOid,
            manifest.resolutionManifest,
            pendingResolutionRequests,
        );
    }

    const occurrence: RepositoryOccurrence = {
        occurrenceId,
        checkoutPath,
        parentOccurrenceId,
        pathInParent,
        gitlinkOid: parentOccurrenceId === null ? null : baseOid,
        depth,
        originUrl: readOriginUrl(checkoutPath),
        baseBranch,
        baseOid,
        operationBranch: existing?.operationBranch ?? "",
        childOccurrenceIds: existing?.childOccurrenceIds ?? [],
        testState: existing?.testState ?? "untested",
    };

    if (existing) {
        Object.assign(existing, occurrence);
    } else {
        occurrences.push(occurrence);
        if (parentOccurrenceId !== null) {
            const parent = occurrences.find((candidate) => candidate.occurrenceId === parentOccurrenceId);
            parent?.childOccurrenceIds.push(occurrenceId);
        }
    }

    const gitlinks = readDirectGitlinks(checkoutPath, baseOid);
    for (const gitlink of gitlinks) {
        const childRelativePath = relativePath === "" ? gitlink.path : `${relativePath}/${gitlink.path}`;
        discoverOccurrenceAndDescendants(
            rootPath,
            childRelativePath,
            occurrenceId,
            gitlink.path,
            depth + 1,
            gitlink.oid,
            manifest,
            pendingResolutionRequests,
        );
    }
}

export function discoverRepositoryTree(rootPath: string, manifest: DiscoveryManifest): DiscoveryResult {
    const pendingResolutionRequests: ResolutionRequest[] = [];
    discoverOccurrenceAndDescendants(rootPath, "", null, null, 0, "", manifest, pendingResolutionRequests);

    if (pendingResolutionRequests.length > 0) {
        return { status: "needsResolution", resolutionRequests: pendingResolutionRequests };
    }

    return { status: "resolved", graph: manifest.repositoryManifest.occurrences };
}

```

### scripts/operationBranches.ts

```
// Creates per-occurrence operation branches at their recorded base OID, checks them out, and records the branch name.
import { execFileSync } from "node:child_process";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";

export class OperationBranchSetupError extends Error {}
export class OperationBranchConflictError extends Error {}

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function isDetachedHead(repoPath: string): boolean {
    try {
        execFileSync("git", ["-C", repoPath, "symbolic-ref", "-q", "HEAD"], { stdio: "ignore" });
        return false;
    } catch {
        return true;
    }
}

function validateOccurrencesReadyForBranching(occurrences: RepositoryOccurrence[]): void {
    const problems: string[] = [];
    for (const occurrence of occurrences) {
        if (isDetachedHead(occurrence.checkoutPath)) {
            problems.push(`  - ${occurrence.checkoutPath}: detached HEAD`);
        } else if (occurrence.baseBranch === "") {
            problems.push(`  - ${occurrence.checkoutPath}: baseBranch not resolved`);
        }
    }
    if (problems.length > 0) {
        throw new OperationBranchSetupError(
            `Cannot set up operation branches, ${problems.length} occurrence(s) not ready:\n${problems.join("\n")}`,
        );
    }
}

export function operationBranchName(runId: string, occurrence: RepositoryOccurrence): string {
    const occurrenceSegment = occurrence.occurrenceId === "" ? "root" : occurrence.occurrenceId;
    return `operations/${runId}/${occurrenceSegment}`;
}

function branchOid(repoPath: string, branchName: string): string | null {
    try {
        return git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`);
    } catch {
        return null;
    }
}

function ensureOperationBranchAtOid(repoPath: string, branchName: string, recordedOid: string): void {
    const existingOid = branchOid(repoPath, branchName);
    if (existingOid === null) {
        git(repoPath, "branch", branchName, recordedOid);
        return;
    }
    if (existingOid !== recordedOid) {
        throw new OperationBranchConflictError(
            `Operation branch conflict at ${repoPath}: branch "${branchName}" expected to point at ${recordedOid} but points at ${existingOid}`,
        );
    }
}

export function setUpOperationBranches(
    occurrences: RepositoryOccurrence[],
    runId: string,
): RepositoryOccurrence[] {
    validateOccurrencesReadyForBranching(occurrences);
    return occurrences.map((occurrence) => {
        const branchName = operationBranchName(runId, occurrence);
        ensureOperationBranchAtOid(occurrence.checkoutPath, branchName, occurrence.baseOid);
        git(occurrence.checkoutPath, "checkout", branchName);
        return { ...occurrence, operationBranch: branchName };
    });
}

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

### scripts/mergePipeline.ts

```
// Translates the CLI's flat merge input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type WorkflowArguments } from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization, finalizeApprovedRun, computeApprovalDigest, type OccurrenceSnapshot, type RunState, type ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { validateRepositoryManifest, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
import { buildOperationPushOccurrences } from "./operationBranches.ts";
import { normalizeRepositoryIdentity, type RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import { consolidateRun, type GroupOccurrenceBranch, type LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import { pushOperationBranches, type OperationPushInput } from "./operationPush.ts";
import { publishBases, readCurrentRefOid, type PublicationTarget } from "./basePublication.ts";
import { summarizeTaskMergeResults, archivePublishedTasks, type RawTaskRepoOutcome } from "./taskArchival.ts";
import { runFinalization } from "./runAuthorization.ts";
export type CliInput = WorkflowArguments & {
    runId?: string; startTimestamp?: string; doneCount?: number; partialCount?: number; blockedCount?: number;
    needsClarificationCount?: number; requeueCount?: number; testReceipts?: TestReceipt[]; reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };
export type MergeOutcome = { groupId: number; merged: boolean; conflictedFilePaths: string[]; submoduleConflicts: SubmoduleConflict[]; worktree: string; failureReason: string | null };
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
type Coordinate = { repoRoot: string; relativePath: string };
type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}
function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }
function parseMergeTreeConflicts(stdout: string): string[] {
    const [, ...lines] = (stdout.split("\n\n")[0] ?? "").split("\n");
    return [...new Set(lines.filter(Boolean).map((line) => line.split("\t")[1]))];
}
function occurrenceToLogicalId(groups: LogicalGroup[], occurrenceId: string): string { return groups.find((g) => g.occurrenceIds.includes(occurrenceId))!.logicalId; }
function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
    const repoResolved = resolve(repo);
    const coordinates = new Map<string, Coordinate>();
    for (const occurrence of manifest.occurrences) {
        const repoRoot = occurrence.checkoutPath.startsWith("/") ? occurrence.checkoutPath : join(repo, occurrence.checkoutPath);
        const relativePath = repoRoot === repoResolved ? "" : relative(repoResolved, repoRoot);
        if (relativePath.startsWith("..")) throw new Error(`occurrence "${occurrence.occurrenceId}" checkout path "${repoRoot}" is outside repo "${repo}"`);
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
    const byKey = new Map<string, string[]>();
    for (const occurrence of manifest.occurrences) {
        const key = identityKey(occurrence);
        const existing = byKey.get(key);
        if (existing) existing.push(occurrence.occurrenceId); else byKey.set(key, [occurrence.occurrenceId]);
    }
    return [...byKey.entries()].map(([key, occurrenceIds]) => ({ logicalId: sanitizeSegment(key), occurrenceIds, canonicalOccurrenceId: occurrenceIds[0] }));
}
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
    const occurrenceToLogical = new Map<string, string>();
    for (const group of groups) for (const id of group.occurrenceIds) occurrenceToLogical.set(id, group.logicalId);
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const byId = new Map(groups.map((g) => [g.logicalId, g]));
    const mark = new Map<string, "gray" | "black">();
    const order: LogicalGroup[] = [];
    function visit(logicalId: string, path: string[]): void {
        if (mark.get(logicalId) === "black") return;
        if (mark.get(logicalId) === "gray") throw new Error(`logical repository dependency cycle: ${[...path, logicalId].join(" -> ")}`);
        mark.set(logicalId, "gray");
        const group = byId.get(logicalId)!;
        for (const occurrenceId of group.occurrenceIds) for (const childId of occurrenceById.get(occurrenceId)!.childOccurrenceIds) {
            const childLogicalId = occurrenceToLogical.get(childId)!;
            if (childLogicalId !== logicalId) visit(childLogicalId, [...path, logicalId]);
        }
        mark.set(logicalId, "black");
        order.push(group);
    }
    for (const group of groups) visit(group.logicalId, []);
    return order;
}
export async function runMergePipeline(input: CliInput): Promise<void> {
    const manifest = input.repositoryManifest;
    if (!manifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const validation = validateRepositoryManifest(manifest);
    if (!validation.valid) throw new Error(`invalid repository manifest: ${validation.errors.join("; ")}`);
    const roots = manifest.occurrences.filter((o) => o.parentOccurrenceId === null);
    if (roots.length !== 1) throw new Error(`repository manifest must have exactly one root occurrence, found ${roots.length}`);
    if (input.groups.length === 0) throw new Error("no groups given in CLI input");
    const rootOccurrence = roots[0];
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const runId = input.runId ?? `merge-${Date.now()}-${process.pid}`;
    execFileSync("git", ["check-ref-format", `refs/heads/${runId}/probe`]);
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const coordinates = buildCoordinates(input.repo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    const groupRepoRootFor = (groupWorktree: string, occurrenceId: string): string =>
        coordinates.get(occurrenceId)!.relativePath === "" ? groupWorktree : join(groupWorktree, coordinates.get(occurrenceId)!.relativePath);
    const rawTips = new Map<string, Map<number, string>>();
    for (const occurrence of manifest.occurrences) rawTips.set(occurrence.occurrenceId, new Map(sortedGroups.map((group) => [group.groupId, git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "rev-parse", "HEAD").trim()])));
    const baseMismatch = logicalGroups.find((group) => new Set(group.occurrenceIds.map((id) => occurrenceById.get(id)!.baseOid)).size > 1);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        let rootConflictedPaths: string[] = [];
        let failed = baseMismatch !== undefined;
        for (const occurrence of manifest.occurrences) {
            const coordinate = coordinates.get(occurrence.occurrenceId)!;
            const groupRepoRoot = groupRepoRootFor(group.worktree, occurrence.occurrenceId);
            const tipOid = rawTips.get(occurrence.occurrenceId)!.get(group.groupId)!;
            try {
                execFileSync("git", ["-C", groupRepoRoot, "merge-tree", "--write-tree", occurrence.baseOid, tipOid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            } catch (error) {
                failed = true;
                const conflictedPaths = parseMergeTreeConflicts((error as { stdout?: string }).stdout ?? "");
                if (coordinate.relativePath === "") rootConflictedPaths = conflictedPaths;
                else submoduleConflicts.push({ path: coordinate.relativePath, conflictedFilePaths: conflictedPaths, failureReason: null });
            }
        }
        const outcome: MergeOutcome = { groupId: group.groupId, merged: !failed, conflictedFilePaths: failed ? rootConflictedPaths : [], submoduleConflicts, worktree: group.worktree, failureReason: null };
        (failed ? conflicts : merged).push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0;
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => ({
        groupId: outcome.groupId, repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath,
        treeListing: git(groupRepoRootFor(outcome.worktree, occurrence.occurrenceId), "ls-tree", "-r", "-z", "HEAD"),
    })));
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const operationRef = digestIds(sortedGroups.flatMap((group) => manifest.occurrences.map((o) => `${group.groupId}:${o.occurrenceId}:${rawTips.get(o.occurrenceId)!.get(group.groupId)}`)));
    const readyForApproval = allGroupsMerged && testReceipts.length > 0 && testReceipts.every((receipt) => receipt.status === "green") && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    const endMetrics = (conflictCount: number): void => {
        const endTimestamp = new Date().toISOString();
        const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources };
        appendRunMetricsRecord(input.repo, {
            runId: input.runId ?? endTimestamp, startTimestamp: input.startTimestamp ?? null, endTimestamp,
            durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
            taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), groupCount: sortedGroups.length,
            doneCount: input.doneCount ?? 0, partialCount: input.partialCount ?? 0, blockedCount: input.blockedCount ?? 0,
            needsClarificationCount: input.needsClarificationCount ?? 0, requeueCount: input.requeueCount ?? 0,
            conflictCount, argumentsHash: computeArgumentsHash(workflowArguments),
        });
    };
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason })); };
    if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
    recordApproval(runState);
    const token = issueApprovalAuthorization(runState);
    const digest = computeApprovalDigest(runState.digestInput); let abortReason: string | null = null;
    const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
        const consolidations = new Map<string, ConsolidationOutcome>();
        for (const logicalGroup of logicalGroups) {
            const canonicalRepoRoot = coordinates.get(logicalGroup.canonicalOccurrenceId)!.repoRoot;
            const canonicalOccurrence = occurrenceById.get(logicalGroup.canonicalOccurrenceId)!;
            const participatingBranches: GroupOccurrenceBranch[] = [];
            for (const occurrenceId of logicalGroup.occurrenceIds) {
                const occurrence = occurrenceById.get(occurrenceId)!;
                const occurrenceSegment = sanitizeSegment(occurrenceId);
                for (const group of sortedGroups) {
                    const repoRoot = groupRepoRootFor(group.worktree, occurrenceId);
                    const proxyId = (childId: string): string => `proxy-${sanitizeSegment(childId)}`;
                    const directChildEdges = occurrence.childOccurrenceIds.map((childId) => ({ pathInParent: occurrenceById.get(childId)!.pathInParent!, childOccurrenceId: proxyId(childId) }));
                    const proxyInputs = occurrence.childOccurrenceIds.map((childId) => {
                        const child = consolidations.get(occurrenceToLogicalId(logicalGroups, childId))!;
                        return { occurrenceId: proxyId(childId), repoRoot: child.canonicalRepoRoot, currentTipOid: child.preparedIntegrationOid, recordedBaseOid: child.preparedIntegrationOid, approvedOwnFileChanges: [], directChildEdges: [] };
                    });
                    const finalizationRunId = `${runId}-finalize-${sanitizeSegment(logicalGroup.logicalId)}-${group.groupId}`;
                    const result = finalizeApprovedRun(runState, {
                        runId: finalizationRunId,
                        occurrences: [{ occurrenceId: occurrenceSegment, repoRoot, currentTipOid: rawTips.get(occurrenceId)!.get(group.groupId)!, recordedBaseOid: rawTips.get(occurrenceId)!.get(group.groupId)!, approvedOwnFileChanges: [], directChildEdges }, ...proxyInputs],
                    });
                    const finalizedOid = result.occurrences.find((o) => o.occurrenceId === occurrenceSegment)!.finalizedIntegrationOid;
                    const groupSegment = String(group.groupId).padStart(6, "0");
                    if (repoRoot !== canonicalRepoRoot) git(canonicalRepoRoot, "fetch", repoRoot, finalizedOid);
                    git(canonicalRepoRoot, "update-ref", `refs/heads/${groupSegment}/${occurrenceSegment}`, finalizedOid);
                    participatingBranches.push({ groupId: groupSegment, occurrencePath: occurrenceSegment, occurrenceId, branchOid: finalizedOid, sourceRepoRoot: canonicalRepoRoot });
                }
            }
            const sorted = [...participatingBranches].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.occurrencePath.localeCompare(b.occurrencePath));
            let previewOid = sorted[0].branchOid;
            for (let i = 1; i < sorted.length; i++) {
                const foldResult = prepareNoFfMerge(canonicalRepoRoot, previewOid, sorted[i].branchOid, `preview fold ${runId}`);
                if (!foldResult.merged) return true; else previewOid = foldResult.commitOid;
            }
            const approvedConvergedTreeOid = git(canonicalRepoRoot, "rev-parse", `${previewOid}^{tree}`).trim();
            const consolidationInput: LogicalRepositoryConsolidationInput = {
                logicalRepositoryId: logicalGroup.logicalId, canonicalRepoRoot, canonicalOccurrenceBranchName: sanitizeSegment(logicalGroup.logicalId),
                participatingBranches, approvedConvergedTreeOid, finalizedChildGitlinks: [],
                recordedBaseOid: canonicalOccurrence.baseOid, baseBranchRef: `refs/heads/${canonicalOccurrence.baseBranch}`,
            };
            const [result] = consolidateRun(runId, [consolidationInput], token, digest);
            if ("aborted" in result) return true;
            const integrationRef = `refs/finalize/${runId}/integration/${sanitizeSegment(logicalGroup.logicalId)}`;
            git(canonicalRepoRoot, "update-ref", integrationRef, result.preparedIntegrationOid);
            consolidations.set(logicalGroup.logicalId, { preparedIntegrationOid: result.preparedIntegrationOid, canonicalRepoRoot, canonicalRefName: `refs/heads/${canonicalOccurrence.baseBranch}`, recordedBaseOid: canonicalOccurrence.baseOid, integrationRef });
        }
        const operationBranchSegments = new Map(logicalGroups.flatMap((group) => group.occurrenceIds.map((id) => [id, sanitizeSegment(group.logicalId)] as const)));
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId, operationBranchSegments);
        const operationPushLogicalRepositories: LogicalRepository[] = logicalGroups.map((group) => ({
            normalizedIdentity: normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? ({ host: "opaque", owner: "opaque", repository: group.logicalId } as RepositoryIdentity),
            occurrenceIds: group.occurrenceIds, selectedBaseOccurrenceId: group.canonicalOccurrenceId, canonicalOccurrenceId: group.canonicalOccurrenceId,
            lastWriterOccurrenceId: group.occurrenceIds[group.occurrenceIds.length - 1], convergenceDigest: digestIds(group.occurrenceIds),
            consolidationState: group.occurrenceIds.length === 1 ? "single" : "grouped",
        }));
        await pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest);
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
            const consolidation = consolidations.get(group.logicalId)!;
            return {
                name: group.logicalId, canonicalOccurrencePath: consolidation.canonicalRepoRoot, canonicalRefName: consolidation.canonicalRefName,
                otherOccurrences: group.occurrenceIds.filter((id) => id !== group.canonicalOccurrenceId).map((id) => ({ path: coordinates.get(id)!.repoRoot, refName: `refs/heads/${occurrenceById.get(id)!.baseBranch}` })),
                recordedBaseOid: consolidation.recordedBaseOid, targetOid: consolidation.preparedIntegrationOid,
            };
        });
        const rootConsolidation = consolidations.get(logicalGroups.find((g) => g.occurrenceIds.includes(rootOccurrence.occurrenceId))!.logicalId)!;
        const publicationResult = publishBases(publicationTargets, runState, { repoPath: rootConsolidation.canonicalRepoRoot, refName: rootConsolidation.integrationRef });
        if (!publicationResult.published) return true;
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
            taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
        }))));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        endMetrics(0);
        printResult(summaryTargets);
        return false;
    });
    if (aborted) { endMetrics(conflicts.length + 1); printResult([], abortReason); }
}

```

### tests/runMergePhase.test.ts

```
// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeOutcomes, judgeMergeRun } from "../scripts/runMergePhase.ts";

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

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [{ branch: "new-usage-graph" }] });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "merged");
    assert.equal(verdict.failure, null);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsNonZero", () => {
    const verdict = judgeMergeRun({ exitCode: 1, stdout: "", stderr: "boom" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.failure?.error, "1: boom");
    assert.deepEqual(verdict.failure?.conflicts, []);
    assert.equal(verdict.failure?.failedCommand, "cmd");
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButReportsConflicts", () => {
    const conflicts = [{ groupId: 1, merged: false }];
    const verdict = judgeMergeRun({ exitCode: 0, stdout: JSON.stringify({ merged: [], conflicts }), stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.deepEqual(verdict.failure?.conflicts, conflicts);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptPrintsSomethingOtherThanJson", () => {
    const verdict = judgeMergeRun({ exitCode: 0, stdout: "Debugger attached.", stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /not JSON/);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [], runState: { status: "approved" } });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /published nothing/);
});

```
