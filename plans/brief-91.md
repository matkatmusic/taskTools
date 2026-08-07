# Task 91: Exported retry coordinator: fresh runId, rewritten occurrence operation branches, refreshed base OIDs, and exactly one merge retry

## User request

[split-task-child] This task is being created by `/split-task` as one of an already-requested set of 4 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `["scripts/runMergePhase.ts"]`.

Child 3 of 4 from parent task 88 ("Auto-rebase onto the moved source branch, re-test, and retry the merge once when a run drifts past its pinned baseOid"). This child owns STEP 3 ONLY: retry the merge exactly once after a successful rebase and passing tests. The rebase itself is child 89, the end-to-end tests are child 90, and the abort reporting in scripts/mergePipeline.ts is a sibling.

Required behavior in scripts/runMergePhase.ts:
1. Export (or extract) the retry coordinator as a testable function, so the full orchestration can be tested and not just its parts. This is a hard requirement from finding 5 of the codex review of the parent's draft plan.
2. The retry must mint a fresh runId AND rewrite every manifest occurrence operationBranch from `operations/{oldRunId}/...` to `operations/{newRunId}/...` before rewriting run-arguments.json. Return blocked if any occurrence lacks the expected old-run prefix. Changing only the top-level runId leaves occurrences pointing at stale refs. This is finding 2 of the codex review.
3. Refresh the per-occurrence base OIDs before retrying.
4. Retry the merge and publication exactly once — never twice. Return blocked if the retried merge publishes nothing (empty publicationTargets) or if the retry hits a second base-drift result.
5. The task-63 guard in judgeMergeRun (lines 35-49 as of version 00365e92) that reports blocked on a clean exit with empty publicationTargets must keep working; the invariant is non-negotiable — a merged verdict must imply the source branch actually contains the task commits.

Files: scripts/runMergePhase.ts

Tests: prove a passing test run invokes the merge script exactly once with refreshed per-occurrence base OIDs, a fresh runId, and every occurrence operationBranch rewritten to the new runId; prove an occurrence missing the expected old-run prefix returns blocked; prove an empty publicationTargets on the retry, or a second base-drift result, returns blocked without attempting a further retry.

Difficulty: 4

Step 3 of the 4-way split of task 88 (rebase → test → retry merge → report). Scope is scripts/runMergePhase.ts only. The rebase primitive lives in scripts/mergeTaskWorktrees.ts (task 89), the end-to-end assertions in tests/runMergePhase.test.ts (task 90), and the base-drift abort reason in scripts/mergePipeline.ts (the reporting child). This child consumes 89's rebase result and is exercised by 90's tests, so it must not edit either file — its own test coverage is written by task 90.

Deliverable: a retry coordinator, exported or extracted as a standalone testable function rather than buried in a CLI main, that runs only after the rebase reports clean and the covering tests pass, and then retries the merge and publication exactly once.

Hard constraints, from the codex review that rejected the parent's draft plan:
- Finding 2: minting a fresh runId is not sufficient. Every manifest occurrence's operationBranch must also be rewritten from operations/{oldRunId}/... to operations/{newRunId}/... BEFORE run-arguments.json is rewritten; otherwise the retry reuses stale refs while the top-level runId claims to be new. If any occurrence's operationBranch does not carry the expected old-run prefix, return blocked rather than guessing at a rewrite.
- Finding 5: the coordinator must be testable as a whole, not only through its parts.

Per-occurrence base OIDs must be refreshed against the current source-branch tip before the retry, since the stale pinned OIDs are exactly what caused the abort.

Exactly one retry. A second base-drift result, or a retry that exits clean with empty publicationTargets, is blocked — no further attempt. The task-63 guard already sitting in judgeMergeRun (scripts/runMergePhase.ts lines 35-49 as of version 00365e92, between the conflicts check and the final merged return) must keep firing; it is the backstop for the non-negotiable invariant that a merged verdict implies the source branch really contains the task commits.

Run artifacts involved: .taskTools/run-arguments.json, plus the run manifest whose occurrences carry operationBranch values. Source files are capped at 250 lines — extract the coordinator into its own module if scripts/runMergePhase.ts would grow past the cap.

### scripts/runMergePhase.ts

```
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";

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

function runScript(command: string[]): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8" }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", resolveRunArgumentsPath(repoRoot), outcomesFile];
    process.stdout.write(JSON.stringify(judgeMergeRun(runScript(command), repoRoot, command.join(" "))));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/repositoryManifest.ts

```
// Versioned repository occurrence graph: one RepositoryOccurrence per checked-out repository location.
import { readFileSync, writeFileSync } from "node:fs";

export const REPOSITORY_MANIFEST_VERSION = 1;

export type TestState = "untested" | "passed" | "failed";

export type RepositoryOccurrence = {
    occurrenceId: string;
    checkoutPath: string;
    parentOccurrenceId: string | null;
    pathInParent: string | null;
    gitlinkOid: string | null;
    depth: number;
    originUrl: string;
    baseBranch: string;
    baseOid: string;
    operationBranch: string;
    childOccurrenceIds: string[];
    testState: TestState;
};

export type RepositoryManifest = {
    version: number;
    occurrences: RepositoryOccurrence[];
};

export function readRepositoryManifest(path: string): RepositoryManifest {
    return JSON.parse(readFileSync(path, "utf8"));
}

export function writeRepositoryManifest(path: string, manifest: RepositoryManifest): void {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

export type ManifestValidationResult = { valid: boolean; errors: string[] };

// Walks parentOccurrenceId edges from `occurrence` to a root, counting hops.
function depthFromParentChain(
    occurrence: RepositoryOccurrence,
    occurrenceById: Map<string, RepositoryOccurrence>,
): number | null {
    const visited = new Set<string>();
    let current = occurrence;
    let depth = 0;
    while (current.parentOccurrenceId !== null) {
        if (visited.has(current.occurrenceId)) return null;
        visited.add(current.occurrenceId);
        const parent = occurrenceById.get(current.parentOccurrenceId);
        if (!parent) return null;
        depth += 1;
        current = parent;
    }
    return depth;
}

export function validateRepositoryManifest(manifest: RepositoryManifest): ManifestValidationResult {
    const errors: string[] = [];
    const occurrenceById = new Map<string, RepositoryOccurrence>();
    const duplicateIds = new Set<string>();
    for (const occurrence of manifest.occurrences) {
        if (occurrenceById.has(occurrence.occurrenceId)) duplicateIds.add(occurrence.occurrenceId);
        occurrenceById.set(occurrence.occurrenceId, occurrence);
    }
    for (const duplicateId of duplicateIds) {
        errors.push(`duplicate occurrence ID: "${duplicateId}"`);
    }

    for (const occurrence of manifest.occurrences) {
        if (occurrence.parentOccurrenceId === null) continue;
        if (!occurrenceById.has(occurrence.parentOccurrenceId)) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has a dangling parent occurrence ID "${occurrence.parentOccurrenceId}"`,
            );
        }
    }

    for (const occurrence of manifest.occurrences) {
        const expectedDepth = depthFromParentChain(occurrence, occurrenceById);
        if (expectedDepth !== null && occurrence.depth !== expectedDepth) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has depth ${occurrence.depth}, expected ${expectedDepth} from its parent chain`,
            );
        }
    }

    return { valid: errors.length === 0, errors };
}

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
    return `tackle-op/${runId}/${occurrenceSegment}`;
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

```

### scripts/basePublication.ts

```
// basePublication.ts: local base publication with CAS, whole-run rollback, and recovery reporting.  Phase 4 of the recursive repository-discovery redesign.
import { spawnSync } from "node:child_process";
import { checkAuthorizationDrift } from "./approvalGate.ts";
import type { RunState } from "./approvalGate.ts";

export type PublicationTarget = {
    name: string;
    canonicalOccurrencePath: string;
    canonicalRefName: string;
    otherOccurrences: { path: string; refName: string }[];
    recordedBaseOid: string;
    targetOid: string;
};

export type UpdatedRef = {
    repoName: string;
    occurrencePath: string;
    refName: string;
    recordedOid: string;
    newOid: string;
};

export type RollbackOutcome = {
    ref: UpdatedRef;
    rolledBack: boolean;
    recoveryCommand: string;
};

export type PublicationResult = {
    published: boolean;
    rollback: RollbackOutcome[];
};

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

export function readCurrentRefOid(repoPath: string, refName: string): string | null {
    const result = runGit(repoPath, ["rev-parse", "--verify", "--quiet", refName]);
    return result.ok ? result.stdout.trim() : null;
}

export function checkRootIntegrationOidExists(repoPath: string, rootIntegrationRef: string): boolean {
    return readCurrentRefOid(repoPath, rootIntegrationRef) !== null;
}

export function revalidateRecordedBaseOids(repos: PublicationTarget[]): { ok: boolean; moved: PublicationTarget[] } {
    const moved = repos.filter(
        (repo) => readCurrentRefOid(repo.canonicalOccurrencePath, repo.canonicalRefName) !== repo.recordedBaseOid,
    );
    return { ok: moved.length === 0, moved };
}

export function revalidateApprovalInputs(approvalState: RunState): boolean {
    return checkAuthorizationDrift(approvalState);
}

export function publishCanonicalRef(repo: PublicationTarget): { ok: boolean; updated?: UpdatedRef } {
    const result = runGit(repo.canonicalOccurrencePath, [
        "update-ref",
        repo.canonicalRefName,
        repo.targetOid,
        repo.recordedBaseOid,
    ]);
    if (!result.ok) return { ok: false };
    return {
        ok: true,
        updated: {
            repoName: repo.name,
            occurrencePath: repo.canonicalOccurrencePath,
            refName: repo.canonicalRefName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        },
    };
}

export function fastForwardOtherOccurrences(
    repo: PublicationTarget,
): { ok: boolean; updated: UpdatedRef[]; failedAt?: string } {
    const updated: UpdatedRef[] = [];
    for (const occurrence of repo.otherOccurrences) {
        // No --force: a plain "src:dst" fetch refspec already refuses a non-fast-forward move.
        const result = runGit(occurrence.path, [
            "fetch",
            repo.canonicalOccurrencePath,
            `${repo.canonicalRefName}:${occurrence.refName}`,
        ]);
        if (!result.ok) {
            return { ok: false, updated, failedAt: occurrence.path };
        }
        updated.push({
            repoName: repo.name,
            occurrencePath: occurrence.path,
            refName: occurrence.refName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        });
    }
    return { ok: true, updated };
}

export function formatRecoveryCommand(ref: UpdatedRef): string {
    return `git -C ${ref.occurrencePath} update-ref ${ref.refName} ${ref.recordedOid}`;
}

export function rollbackUpdatedRefs(updated: UpdatedRef[]): RollbackOutcome[] {
    return updated.map((ref) => {
        const result = runGit(ref.occurrencePath, ["update-ref", ref.refName, ref.recordedOid, ref.newOid]);
        return { ref, rolledBack: result.ok, recoveryCommand: formatRecoveryCommand(ref) };
    });
}

export function publishBases(
    repos: PublicationTarget[],
    approvalState: RunState,
    rootIntegration: { repoPath: string; refName: string },
): PublicationResult {
    if (!checkRootIntegrationOidExists(rootIntegration.repoPath, rootIntegration.refName)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateApprovalInputs(approvalState)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateRecordedBaseOids(repos).ok) {
        return { published: false, rollback: [] };
    }

    const updatedSoFar: UpdatedRef[] = [];
    let pass2Failed = false;
    for (const repo of repos) {
        const canonicalResult = publishCanonicalRef(repo);
        if (!canonicalResult.ok) {
            pass2Failed = true;
            break;
        }
        updatedSoFar.push(canonicalResult.updated!);

        const fastForwardResult = fastForwardOtherOccurrences(repo);
        updatedSoFar.push(...fastForwardResult.updated);
        if (!fastForwardResult.ok) {
            pass2Failed = true;
            break;
        }
    }

    if (!pass2Failed) {
        return { published: true, rollback: [] };
    }
    return { published: false, rollback: rollbackUpdatedRefs(updatedSoFar) };
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
        const operationPushOccurrences = manifest.occurrences.map((occurrence) => {
            const logicalGroup = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}` };
        });
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

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergePipeline.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrorText(error: unknown): string {
    const failure = error as { stderr?: string; message?: string };
    return (failure.stderr || failure.message || "git merge failed").trim();
}

export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionDir = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    // git resolves symlinks in the paths it reports (e.g. macOS /var -> /private/var); match on the resolved form.
    if (!existsSync(conventionDir)) return [];
    const conventionRoot = realpathSync(conventionDir);
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^group-\d+$/.test(basename(worktree.path));
    });
}

function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}

export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export type RebaseOutcome =
    | { status: "rebased-clean" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string };

function rebaseGitPath(worktreePath: string, relativePath: string): string {
    const output = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    return isAbsolute(output) ? output : join(worktreePath, output);
}

function rebaseInProgress(worktreePath: string): boolean {
    return existsSync(rebaseGitPath(worktreePath, "rebase-merge")) || existsSync(rebaseGitPath(worktreePath, "rebase-apply"));
}

function collectConflictedRebasePaths(worktreePath: string): string[] {
    return git(worktreePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

function abortRebase(worktreePath: string): { aborted: boolean; failureReason: string | null } {
    try {
        git(worktreePath, "rebase", "--abort");
        return { aborted: true, failureReason: null };
    } catch (error) {
        return { aborted: false, failureReason: gitErrorText(error) };
    }
}

function combineFailureReasons(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join("; ");
}

export function rebaseGroupOntoSource(worktreePath: string, sourceBranch: string): RebaseOutcome {
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        const originalReason = gitErrorText(rebaseError);

        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: originalReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(collectionError), abortFailure) };
        }

        const abortResult = abortRebase(worktreePath);
        if (!abortResult.aborted) {
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, `abort also failed: ${abortResult.failureReason}`) };
        }

        if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: originalReason };

        return { status: "conflicted", conflictedFilePaths };
    }
}

export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[]; startFailed: boolean } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // No unmerged paths means the merge never started, so there is nothing to abort, stage, or commit.
    if (conflictedPaths.length === 0) return { resolved: false, unexpectedConflicts: [], startFailed: true };
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts, startFailed: false };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [], startFailed: false };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        // Same rule as the parent repo: with no unmerged paths there is no merge in progress to abort.
        if (conflictedFilePaths.length === 0) return { merged: false, conflictedFilePaths, failureReason: gitErrorText(error) };
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths, failureReason: null };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}

function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

async function runAsCli(): Promise<void> {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    await runMergePipeline(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    runAsCli().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}

```

---

## SECOND MANDATORY AMENDMENT — ownership widened, requirement #2 corrected

Codex rejected the second plan too, and it was **right about the code**. Verified
facts, confirmed by reading the source:

- `scripts/operationBranches.ts:39` names operation branches `tackle-op/{runId}/{occurrenceId}`.
  There is no `operations/{runId}/...` value anywhere in the persisted manifest.
- `scripts/mergePipeline.ts:212` does build `operations/{runId}/{logicalId}`, but only into
  a local `operationPushOccurrences` array handed to `pushOperationBranches`. It is never
  written back to the manifest.
- `setUpOperationBranches` (`scripts/operationBranches.ts:63`) is the only function that
  ever assigns `occurrence.operationBranch`, and it has **no callers** in `scripts/`.
  Consequently every occurrence in `.taskTools/run-arguments.json` carries
  `"operationBranch": ""` in real runs.

The original task text assumed occurrences already carry `operations/{oldRunId}/...`.
They do not. A prefix check against that value would return blocked on 100% of retries,
so the retry feature would never fire once.

**The user has decided to widen this task's ownership rather than drop the requirement.**

### Owned files — exactly these three, and no others

1. `scripts/runMergePhase.ts` (71 lines)
2. `scripts/mergePipeline.ts` (249 lines — **one line under the 250 cap**)
3. `scripts/operationBranches.ts` (74 lines)

`scripts/mergePipeline.ts` cannot absorb even one added line. If the plan needs to change
it, the plan must **first** specify an extraction that moves a coherent chunk out into a
new module, and only then add. State that extraction explicitly as its own step.

### What the plan must now do

1. **Persist real operation-branch names into the manifest** so the prefix check is
   meaningful. The value written must be the one the retry can validate and rewrite.
   Pick ONE naming scheme and use it consistently across `operationBranches.ts`,
   `mergePipeline.ts`, and `runMergePhase.ts` — do not leave two competing prefixes.
   Say in the plan which prefix won and why.
2. **Wire the coordinator into production.** `runAsCli()` in `scripts/runMergePhase.ts`
   must change. Show the exact condition that identifies a first base-drift block, the
   single call to the coordinator, and how its verdict is emitted. Preserve the existing
   behaviour for every other outcome. No loop, no recursion, no second retry.
3. **Injectable dependencies** for run-ID generation, ref lookup, argument writing, and
   script execution, so the whole coordinator is deterministically testable. Generation
   must repeat until `newRunId !== oldRunId`.
4. **Resolve relative checkout paths against `repoRoot`** before reading
   `refs/heads/{baseBranch}` when refreshing base OIDs — mirror what the pipeline already does.
5. **Refresh per-occurrence base OIDs** against the current source-branch tip before retrying.
6. **Keep the task-63 guard** in `judgeMergeRun` (empty `publicationTargets` on a clean exit
   returns blocked) exactly as it is.
7. **Tests must record calls**, proving: exactly one merge invocation; the written arguments
   carry a different runId, every rewritten operation branch, and refreshed OIDs; a missing
   prefix invokes the merge script zero times; empty publication or a second drift returns
   blocked with no further invocation.

---

## THIRD MANDATORY AMENDMENT — answers to codex's four remaining objections

Codex rejected round 3. All four of its objections have concrete, verified answers.
Use them. Do not re-derive them, and do not substitute alternatives.

### 1. The coordinator must be exported, not buried in `runAsCli()`

Add an exported, dependency-injected `coordinateMergeRetry(...)` in
`scripts/runMergePhase.ts` that owns the whole flow:

  run the initial merge → judge it → return that verdict unless it is a confirmed
  base drift → run the rebase/retest gate → call the retry at most once → return.

`runAsCli()` must shrink to: resolve paths, build the real dependencies, call
`coordinateMergeRetry(...)`, and `process.stdout.write` its verdict. No orchestration
logic may remain in `runAsCli()`.

### 2. The post-rebase test signal — this mechanism EXISTS, use it

`scripts/testPolicy.ts` is **imported, never edited** (it is not an owned file, and
importing is not editing). Verified signatures:

```ts
export function discoverTestPolicy(
    occurrenceId: string,
    checkoutPath: string,
    resolutionManifest: ResolutionManifest
): TestPolicyResult;

export type TestPolicy = { occurrenceId: string; relatedTestCommand: string; completeSuiteCommand: string };
export type TestPolicyResult =
    | { status: "resolved"; policy: TestPolicy }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };
```

The post-rebase test command is `policy.completeSuiteCommand` from a
`status: "resolved"` result. A `status: "needsResolution"` result is **blocked** —
the retry must not proceed and must not guess a command.

`createEmptyResolutionManifest` is exported from `scripts/resolutionRequests.ts` for
building the manifest argument.

Do **not** use `typecheckCommand` as a stand-in for tests. That substitution was
rejected.

### 3. Never `command.split(" ")`

`scripts/runMergePhase.ts` already has the correct pattern at its `runScript` helper:
`execFileSync(command[0], command.slice(1), { encoding: "utf8" })` with an argument
array. Reuse that shape. Splitting a command string on spaces breaks quoted arguments
and was rejected.

### 4. `scripts/mergePipeline.ts` line cap — extract, do not cram

`mergePipeline.ts` is at 249 of 250 lines. Do **not** put two statements on one line to
stay under the cap. Instead extract the operation-branch construction block currently at
`scripts/mergePipeline.ts:210-213` (the `operationPushOccurrences` map that builds
`operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}`) into
`scripts/operationBranches.ts`, which is already an owned file with room (74 lines).
`mergePipeline.ts` then calls that extracted function on its own line, and the file gets
shorter, not longer. Name the exact lines moved in the plan.

### Still binding from the earlier amendments

Fresh runId generated until `newRunId !== oldRunId`; every occurrence `operationBranch`
rewritten to the new runId before `run-arguments.json` is written; blocked if any
occurrence lacks the expected old-run prefix; per-occurrence base OIDs refreshed with
relative checkout paths resolved against `repoRoot`, failing closed to blocked on a
failed ref lookup rather than falling back to the stale OID; the rebase gate uses the
already-exported `rebaseGroupOntoSource` from `scripts/mergeTaskWorktrees.ts` (imported,
not edited); exactly one retry, no loop, no recursion; the task-63 empty-
`publicationTargets` guard in `judgeMergeRun` left intact.

Tests must record calls and prove: exactly one merge invocation on the happy path with a
different runId, rewritten branches and refreshed OIDs in the written arguments; a missing
prefix invokes the merge script zero times; a failed rebase/test gate blocks; empty
publication on the retry blocks; a second drift blocks with no third invocation.
