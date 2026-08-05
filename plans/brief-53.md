# Task 53: Mint the run authorization in mergeTaskWorktrees and widen its CLI input to carry the evidence

Re-scoped on 2026-08-05 after codex rejected the wider version twice. The two jobs it could not do inside its fence were split into task 56 (produce real TestReceipts and reviewHandoffs) and task 57 (rename the colliding LogicalRepository type). This task is now only the merge-side plumbing, and both of those must land first.

Read plans/task-53-plan.md first; it holds the rejected plan plus codex verdicts. The chosen direction, already decided by the user, is to widen the CLI contract rather than add a prerequisite phase — mergeTaskWorktrees.ts keeps its front door as a flat JSON argv 2, and the extra evidence rides on that JSON.

Widen CliInput to carry the repository manifest, occurrence data, testReceipts and reviewHandoffs that task 56 now produces, have skills/tackle-tasks/merge.workflow.js pass them through from its ARGS without fabricating any of them, and mint the authorization through the recordApproval then issueApprovalAuthorization flow in scripts/approvalGate.ts.

Codex named five concrete requirements the implementation must satisfy, all of which the previous plan failed:
1. Load and retain the repository manifest BEFORE any merge runs, so recordedBaseOid captures the pre-merge base OID; loading it afterwards makes recordedBaseOid equal targetOid and defeats base-movement detection.
2. Build publication targets after successful merges, using pre-merge baseOid as recordedBaseOid and current canonical HEAD OIDs as targetOid.
3. Return the complete approved RunState, not just a token — basePublication.publishBases needs the whole state, and task 49 needs it exposed.
4. Mint approval only when conflicts is empty, every expected group merged, all receipts are green, and both receipts and review handoffs are non-empty.
5. Define operationRef as the post-merge root HEAD OID and baseRef as the pre-merge root occurrence baseOid. Joining group branch names with commas is not a repository ref.

Tests must be at CLI level and prove: evidence actually reaches the pipeline, a conflicted run produces no approval state, and publication targets keep pre-merge base OIDs while using post-merge target OIDs.

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { computeOccurrenceDigests } from "./approvalGate.ts";
import type { OccurrenceSnapshot } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";

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

export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };

export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    submoduleConflicts: SubmoduleConflict[];
    worktree: string;
    failureReason: string | null;
};

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

function runPipelineCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    const workflowArguments: WorkflowArguments = {
        repo: input.repo,
        typecheckCommand: input.typecheckCommand,
        groups: input.groups,
        repositorySources: input.repositorySources,
    };
    const sortedGroups = [...workflowArguments.groups].sort((a, b) => a.groupId - b.groupId);
    const submodulePathsDeepestFirst = workflowArguments.repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const findSourceBranch = (path: string): string => {
        const found = workflowArguments.repositorySources.find((source) => source.path === path);
        if (!found) throw new Error(`no recorded source branch for repository path "${path}"`);
        return found.sourceBranch;
    };

    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        for (const submodulePath of submodulePathsDeepestFirst) {
            const outcome = mergeSubmoduleBranchIntoRepo(
                join(workflowArguments.repo, submodulePath),
                join(group.worktree, submodulePath),
                findSourceBranch(submodulePath),
            );
            if (!outcome.merged) submoduleConflicts.push({ path: submodulePath, conflictedFilePaths: outcome.conflictedFilePaths, failureReason: outcome.failureReason });
        }
        if (submoduleConflicts.length > 0) {
            conflicts.push({ groupId: group.groupId, merged: false, conflictedFilePaths: [], submoduleConflicts, worktree: group.worktree, failureReason: null });
            continue;
        }
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
    }
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => {
        const group = sortedGroups.find((g) => g.groupId === outcome.groupId)!;
        return ["", ...submodulePathsDeepestFirst].map((repositoryPath) => ({
            groupId: group.groupId,
            repositoryPath,
            treeListing: repositoryPath === ""
                ? git(workflowArguments.repo, "ls-tree", "-r", "-z", group.branch)
                : git(join(group.worktree, repositoryPath), "ls-tree", "-r", "-z", "HEAD"),
        }));
    });
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const endTimestamp = new Date().toISOString();
    appendRunMetricsRecord(workflowArguments.repo, {
        runId: input.runId ?? endTimestamp,
        startTimestamp: input.startTimestamp ?? null,
        endTimestamp,
        durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
        taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)),
        groupCount: sortedGroups.length,
        doneCount: input.doneCount ?? 0,
        partialCount: input.partialCount ?? 0,
        blockedCount: input.blockedCount ?? 0,
        needsClarificationCount: input.needsClarificationCount ?? 0,
        requeueCount: input.requeueCount ?? 0,
        conflictCount: conflicts.length,
        argumentsHash: computeArgumentsHash(workflowArguments),
    });
    process.stdout.write(JSON.stringify({
        merged,
        conflicts,
        testReceipts: input.testReceipts ?? [],
        reviewHandoffs: input.reviewHandoffs ?? [],
        occurrenceDigests,
    }));
}

function runAsCli(): void {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    runPipelineCli();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/approvalGate.ts

```
// approvalGate.ts: the single whole-run approval gate -- records approval, issues authorization, invalidates it on drift.
import { createHash } from "node:crypto";
import type { RepositoryManifest } from "./repositoryManifest.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { issueRunAuthorization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import { runFinalizer } from "./runFinalizer.ts";
import type { FinalizationRunInput, FinalizationRunResult } from "./runFinalizer.ts";

export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
    baseRef: string;
    occurrenceDigests: string[];
    testReceipts: TestReceipt[];
    reviewHandoffs: string[];
};

export type Approval = {
    digest: string;
    recordedAt: string;
};

export type RunState = {
    readyForApproval: boolean;
    status: string;
    digestInput: ApprovalDigestInput;
    approval?: Approval;
    authorization?: RunAuthorizationToken;
};

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const entries = keys.map(
            (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
        );
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type OccurrenceSnapshot = { groupId: number; repositoryPath: string; treeListing: string };

// Hashes the whole sorted record, not a git oid, so deletions and gitlinks are just more bytes.
export function computeOccurrenceDigests(snapshots: OccurrenceSnapshot[]): string[] {
    return [...snapshots]
        .sort((a, b) => a.groupId - b.groupId || a.repositoryPath.localeCompare(b.repositoryPath))
        .map((snapshot) => createHash("sha256").update(stableStringify(snapshot)).digest("hex"));
}

export function recordApproval(runState: RunState): Approval {
    if (!runState.readyForApproval) {
        throw new Error("cannot record approval: run is not readyForApproval");
    }
    if (runState.approval !== undefined) {
        throw new Error("cannot record approval: this run already has an approval recorded");
    }
    const approval: Approval = {
        digest: computeApprovalDigest(runState.digestInput),
        recordedAt: new Date().toISOString(),
    };
    runState.approval = approval;
    return approval;
}

export function issueApprovalAuthorization(runState: RunState): RunAuthorizationToken {
    if (runState.approval === undefined) {
        throw new Error("cannot issue authorization before an approval is recorded");
    }
    const authorization = issueRunAuthorization(runState.approval.digest);
    runState.authorization = authorization;
    return authorization;
}

// Recomputes the digest; a mismatch invalidates approval/authorization and returns the run to review.
export function checkAuthorizationDrift(runState: RunState): boolean {
    if (runState.authorization === undefined) return true;
    const currentDigest = computeApprovalDigest(runState.digestInput);
    if (currentDigest === runState.authorization.stateDigest) return true;
    runState.authorization = undefined;
    runState.approval = undefined;
    runState.status = "review";
    return false;
}

export function finalizeApprovedRun(
    runState: RunState,
    finalizationInput: FinalizationRunInput,
): FinalizationRunResult {
    if (runState.authorization === undefined) {
        throw new Error("cannot finalize: run has no issued authorization");
    }
    return runFinalizer(finalizationInput, runState.authorization, computeApprovalDigest(runState.digestInput));
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
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.filter((number): number is number => openNumbers.has(number as number));
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

export function mergeScriptPath(): string {
    return join(import.meta.dirname, "mergeTaskWorktrees.ts");
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

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
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
    process.stdout.write(JSON.stringify({
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: mergeScriptPath(),
    }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### tests/mergeTaskWorktrees.test.ts

```
// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeForGroup } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "mergeTaskWorktrees.ts");

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "merge-worktrees-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return repoRoot;
}

test("test_removeWorktreeAndBranchDeletesAWorktreeThatContainsSubmodules", () => {
    // Setup: a worktree whose submodule was populated by createWorktreeForGroup.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group = makeGroup(repoRoot, 1);
    assert.equal(existsSync(join(group.worktree, "vendor", "seed.txt")), true);
    // Test action and verification: cleanup removes the worktree instead of refusing.
    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
});

test("test_mergeGroupBranchIntoRepoReportsSuccessForANonConflictingBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.deepEqual(outcome.conflictedFilePaths, []);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeGroupBranchIntoRepoReportsConflictedPathsAndAbortsTheMerge", () => {
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

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, ["shared.txt"]);
    const status = git(repoRoot, "status", "--porcelain=v1", "-z").trim();
    assert.equal(status.includes("MERGE_MSG"), false);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_mergeGroupBranchIntoRepoLeavesTheWorktreeInPlaceAfterAConflict", () => {
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

    mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(existsSync(group.worktree), true);
});

test("test_removeWorktreeAndBranchDeletesBothAfterACleanMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    git(repoRoot, "merge", "--no-ff", group.branch, "-q", "-m", "merge");

    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
    const branches = git(repoRoot, "branch", "--list");
    assert.equal(branches.includes(group.branch), false);
});

test("test_mergeGroupBranchIntoRepoContinuesToLaterGroupsAfterAnEarlierConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group1 = makeGroup(repoRoot, 1);
    writeFileSync(join(group1.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group1.worktree, "add", "shared.txt");
    git(group1.worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const group2 = makeGroup(repoRoot, 2);
    writeFileSync(join(group2.worktree, "group2.txt"), "clean add\n");
    git(group2.worktree, "add", "group2.txt");
    git(group2.worktree, "commit", "-q", "-m", "add group2.txt");

    const outcome1 = mergeGroupBranchIntoRepo(repoRoot, group1, sourceBranch, []);
    const outcome2 = mergeGroupBranchIntoRepo(repoRoot, group2, sourceBranch, []);
    assert.equal(outcome1.merged, false);
    assert.equal(outcome2.merged, true);
});

test("test_mergeGroupBranchIntoRepoChecksOutTheSourceBranchBeforeMerging", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    git(repoRoot, "checkout", "-b", "some-other-branch");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.equal(currentBranchName(repoRoot), sourceBranch);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeSubmoduleBranchSurvivesEvenWhenTheGroupConflicts", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const groupBranch = currentBranchName(worktreeSubmodulePath);

    writeFileSync(join(worktreeSubmodulePath, "seed.txt"), "from-worktree\n");
    git(worktreeSubmodulePath, "add", "seed.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(mainSubmodulePath, "seed.txt"), "from-main\n");
    git(mainSubmodulePath, "add", "seed.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "main edit");

    const outcome = mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    assert.equal(outcome.merged, false);
    const branches = git(mainSubmodulePath, "branch", "--list", groupBranch);
    assert.ok(branches.includes(groupBranch));
});

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

test("test_mergeGroupBranchIntoRepoReportsWhyAMergeThatNeverStartedFailed", () => {
    // Setup: an uncommitted local edit that git refuses to overwrite, so the merge never starts.
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(repoRoot, "new.txt"), "untracked squatter\n");

    // Test action and verification: it reports instead of crashing on an empty commit.
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, []);
    assert.ok(outcome.failureReason && outcome.failureReason.length > 0);
});

test("test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const baseBranch = currentBranchName(repoRoot);
    const submoduleBaseBranch = currentBranchName(mainSubmodulePath);

    git(mainSubmodulePath, "checkout", "-b", "branch-a");
    writeFileSync(join(mainSubmodulePath, "a.txt"), "a\n");
    git(mainSubmodulePath, "add", "a.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "a");
    const commitA = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", submoduleBaseBranch);
    git(mainSubmodulePath, "checkout", "-b", "branch-b");
    writeFileSync(join(mainSubmodulePath, "b.txt"), "b\n");
    git(mainSubmodulePath, "add", "b.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "b");
    const commitB = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", commitA);
    git(repoRoot, "checkout", "-b", "feature");
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "feature submodule pointer");

    git(repoRoot, "checkout", baseBranch);
    git(mainSubmodulePath, "checkout", commitB);
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", "feature", "-m", "merge feature");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    // Intended resolution: keep feature's submodule commit.
    git(mainSubmodulePath, "checkout", commitA);

    const resolution = resolveGitlinkConflicts(repoRoot, ["vendor"]);
    assert.equal(resolution.resolved, true);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

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

### skills/tackle-tasks/merge.workflow.js

```
export const meta = {
  name: 'tackle-tasks-merge',
  description: 'Run the merge script, and on failure have a subagent diagnose and fix the blockers before running it again',
  phases: [
    { title: 'Merge', detail: 'run mergeTaskWorktrees.ts' },
    { title: 'Unblock', detail: 'diagnose and fix merge blockers, then merge again' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

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

const DIAGNOSE_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'summary', 'blockers', 'decisions'],
}

// The orchestrator gets the user's approval before this workflow is ever launched.
if (!ARGS.approvedByUser) {
  return { merged: [], conflicts: [], refused: 'merge workflow launched without approvedByUser' }
}

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

const command = `node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`

const runBrief = `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

result = run(${command})

if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, testReceipts: result.stdout.testReceipts, reviewHandoffs: result.stdout.reviewHandoffs, occurrenceDigests: result.stdout.occurrenceDigests, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], testReceipts: [], reviewHandoffs: [], occurrenceDigests: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged, conflicts, testReceipts, reviewHandoffs, or occurrenceDigests values on
the success branch.`

const diagnoseBrief = (run) => `The merge failed.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

repo = ${ARGS.repo}
failedCommand = ${command}
report = ${JSON.stringify({ ok: run.ok, conflicts: run.conflicts ?? [], error: run.error ?? '' })}

decisions = []
blockers = []

for each conflict in report.conflicts:
    if conflict.submoduleConflicts is not empty:
        run scripts/resolveGitlinkConflicts against conflict.worktree
    else if conflict.conflictedFilePaths is not empty:
        for each path in conflict.conflictedFilePaths:
            resolve path in conflict.worktree, keeping BOTH sides' intent
        stage only those paths, then commit

if report.error names a gitlink or submodule path:
    run scripts/resolveGitlinkConflicts against the named worktree
else if report.error names unmerged paths, an unfinished merge, or an unclean tree:
    complete the in-progress merge, or abort it, so the tree is clean
else if report.error is unrecognized:
    identify the real cause
    fix it only if the fix is as concrete and reversible as the branches above

if a blocker needs a user decision (both sides changed the same logic, a
recorded source branch is missing, or the only way forward destroys work):
    leave the repo exactly as you found it
    decisions += the choice itself, with the options you saw
    // example: "group-1 rewrote validateInput() while main deleted it:
    //           keep group-1's version, keep the deletion, or merge both?"

if something else stopped you (a tool failed, no permission, a state you could
not reach):
    blockers += one sentence naming it

if decisions is empty and blockers is empty:
    return {fixed: true, summary: what you changed, blockers: [], decisions: []}
else:
    return {fixed: false, summary: how far you got, blockers: blockers, decisions: decisions}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
failedCommand yourself; or to decide anything in decisions on the user's
behalf. Each entry in decisions must be answerable without opening the repo.
Returning a decision is a correct outcome, not a failure.`

const runMergeScript = (attempt) =>
  agent(runBrief, { label: `merge:run${attempt}`, phase: 'Merge', effort: 'low', schema: RUN_SCHEMA })

const MERGE_OK = 'OK'
const MERGE_FAILED = 'FAILED'

function mergeResultCode(run) {
  if (run === null || run === undefined) return MERGE_FAILED
  if (run.ok !== true) return MERGE_FAILED
  if ((run.conflicts?.length ?? 0) > 0) return MERGE_FAILED
  return MERGE_OK
}

log(`merging ${mergeCliInput.groups.length} group(s)`)
const firstMergeAttempt = await runMergeScript(1)

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

log('merge failed — diagnosing')
const diagnosis = await agent(
  diagnoseBrief(firstMergeAttempt ?? { ok: false, conflicts: [], error: 'merge agent returned no result' }),
  { label: 'merge:unblock', phase: 'Unblock', schema: DIAGNOSE_SCHEMA },
)

const diagnosisMissing = diagnosis === null || diagnosis === undefined
const diagnosisFixed = diagnosisMissing ? false : diagnosis.fixed
const diagnosisSummary = diagnosisMissing
  ? 'the diagnosing agent returned no result, so nothing was diagnosed and nothing was fixed'
  : diagnosis.summary

// A pending decision blocks the retry even when the agent reported fixed.
const decisionsPending = diagnosisMissing ? false : (diagnosis.decisions?.length ?? 0) > 0

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

log('blockers cleared — merging again')
const retry = await runMergeScript(2)
const retryFailed = mergeResultCode(retry) === MERGE_FAILED

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

## Answered clarifications (from the orchestrator, 2026-08-05)

These two type shapes were asked about and are settled — do not ask again.

1. `RepositoryManifest` (scripts/repositoryManifest.ts) is
   `{ version: number; occurrences: RepositoryOccurrence[] }`.
   `RepositoryOccurrence` is
   `{ occurrenceId: string; checkoutPath: string; parentOccurrenceId: string | null;
      pathInParent: string | null; gitlinkOid: string | null; depth: number;
      originUrl: string; baseBranch: string; baseOid: string; operationBranch: string;
      childOccurrenceIds: string[]; testState: "untested" | "passed" | "failed" }`.
   The root occurrence is the one with `parentOccurrenceId === null`
   (equivalently `depth === 0`). So `baseRef` is:
   `manifest.occurrences.find(o => o.parentOccurrenceId === null)?.baseOid`,
   read BEFORE any merge runs. Throw a clear error if there is no root occurrence.

2. `TestReceipt` (scripts/approvalReadiness.ts) is
   `{ groupId: string; status: "green" | "red" }`.
   "All receipts green" means
   `testReceipts.length > 0 && testReceipts.every(r => r.status === "green")`.
