# Task 49: Drive mergeTaskWorktrees through the finalization and publication pipeline

Step 4 of the task 35 cutover split, and its largest behavior change.

Rewire scripts/mergeTaskWorktrees.ts runAsCli to drive scripts/runFinalizer.ts, scripts/runConsolidation.ts, scripts/operationPush.ts, scripts/basePublication.ts and scripts/taskArchival.ts. Read all five in full before editing.

CLI contract decision already made by the user — implement it, do not re-litigate: the script keeps its current front door. It accepts the flat WorkflowArguments JSON as argv[2] and writes the same stdout shape it writes today. Translate the flat arguments into the graph and occurrence shapes INSIDE the script. Every existing test in tests/mergeTaskWorktrees.test.ts must keep passing unchanged, with no rewritten CLI assertions. A graph-shaped front door is a later follow-up.

Keep mergeGroupBranchIntoRepo, mergeSubmoduleBranchIntoRepo, resolveGitlinkConflicts and removeWorktreeAndBranch exported and behaviorally unchanged.

Tests: the existing suite passes unedited; the finalization path is exercised end to end against a temporary repository.

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization } from "./approvalGate.ts";
import type { OccurrenceSnapshot, RunState, ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";

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

export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };

export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    submoduleConflicts: SubmoduleConflict[];
    worktree: string;
    failureReason: string | null;
};

export type PublicationTarget = { repositoryPath: string; recordedBaseOid: string; targetOid: string };

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

function runPipelineCli(input: CliInput): void {
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
    const allGroupsMerged = conflicts.length === 0 && merged.length === sortedGroups.length;
    const operationRef = git(workflowArguments.repo, "rev-parse", "HEAD").trim();
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
    // A failed merge keeps them so the retry still has its inputs.
    if (allGroupsMerged) {
        rmSync(resolveRunArgumentsPath(workflowArguments.repo), { force: true });
        rmSync(resolveRunOutcomesPath(workflowArguments.repo), { force: true });
        rmSync(resolveStepOutputsPath(workflowArguments.repo), { force: true });
    }
    process.stdout.write(JSON.stringify({
        merged,
        conflicts,
        testReceipts,
        reviewHandoffs,
        occurrenceDigests,
        runState,
        publicationTargets,
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
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        runPipelineCli({ ...prepared, ...outcomes });
        return;
    }
    runPipelineCli(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### tests/mergeTaskWorktrees.test.ts

```
// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
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
    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = { ...workflowArguments, repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch) };
    execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });

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

test("test_runFlagReadsPreparedArgumentsAndOutcomesFromDiskThenDeletesThem", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const argumentsFile = resolveRunArgumentsPath(repoRoot);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(argumentsFile), { recursive: true });
    writeFileSync(argumentsFile, JSON.stringify({
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
    }));
    writeFileSync(outcomesFile, JSON.stringify({
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    }));

    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, "--run", argumentsFile, outcomesFile], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.merged.length, 1);
    assert.equal(output.runState.readyForApproval, true);
    assert.deepEqual(output.reviewHandoffs, ["reviewed by codex"]);
    assert.equal(existsSync(argumentsFile), false);
    assert.equal(existsSync(outcomesFile), false);
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

## Read-only reference files (added by the orchestrator, 2026-08-05)

scripts/runFinalizer.ts, scripts/runConsolidation.ts, scripts/operationPush.ts,
scripts/basePublication.ts and scripts/taskArchival.ts are now in your allowed
file list SO THAT YOU CAN READ THEM. They are READ-ONLY references.

DO NOT EDIT any of those five files. The only files this task may modify are
scripts/mergeTaskWorktrees.ts and tests/mergeTaskWorktrees.test.ts. If a change
to one of the five looks necessary, stop and report it as a needs-clarification
question instead of making it.

## Read access widened again (orchestrator, 2026-08-05) — final answer

Every file under scripts/ is now in your allowed list. Read whatever you need:
runAuthorization.ts, ownershipSnapshots.ts, logicalRepository.ts,
repositoryIntegration.ts, gitlinkReader.ts, approvalGate.ts, and the rest.

The EDIT list has not changed and will not change. You may modify ONLY
scripts/mergeTaskWorktrees.ts and tests/mergeTaskWorktrees.test.ts. Every other
scripts/ file is a read-only reference. Do not ask for more read access; you
now have all of it. Write the plan.

## User decision, 2026-08-05 — the publish contradiction is resolved

The planner correctly found that publishBases can never publish while
mergeGroupBranchIntoRepo does `checkout <baseBranch>; merge --no-ff`, because
revalidateRecordedBaseOids (basePublication.ts:48-53) refuses once the base ref
has moved. The user chose: the base branch must NOT be moved by the merge. Only
publishBases may move it, under its compare-and-swap check.

Key discovery that makes this cheap — consolidateLogicalRepository
(runConsolidation.ts:117-170) ALREADY implements exactly that shape. It
fold-merges the participating group branches into an assembly commit, calls
prepareNoFfMerge(canonicalRepoRoot, recordedBaseOid, assemblyOid, ...) to build
the integration commit WITHOUT moving the base branch, and moves an operation
branch ref instead. publishBases then fast-forwards the real base branch under
CAS.

So the implementation is: runAsCli stops driving the legacy
mergeGroupBranchIntoRepo/mergeSubmoduleBranchIntoRepo loop and instead drives
runFinalizer, consolidateRun, pushOperationBranches, publishBases and
archivePublishedTasks. Do not rewrite the merge logic; reuse what already
exists.

Binding rules for this task:

1. mergeGroupBranchIntoRepo, mergeSubmoduleBranchIntoRepo, resolveGitlinkConflicts
   and removeWorktreeAndBranch stay EXPORTED and behaviorally UNCHANGED. They are
   simply no longer what runAsCli calls. Their direct unit tests must keep passing
   untouched.
2. The stdout JSON shape stays as it is today, and the CLI front door stays a
   flat WorkflowArguments JSON in argv[2]. Translate to graph/occurrence shapes
   inside the script.
3. CLI-level tests in tests/mergeTaskWorktrees.test.ts that assert the OLD
   behavior of the base branch moving during the merge MAY be updated, because
   the user has now decided that behavior is wrong. Say clearly in the plan which
   tests change and why. Every other existing test must pass unedited.
4. mergeTaskWorktrees.ts is already 354 lines, over the 250-line cap. Put the new
   translation/wiring code in a NEW file, scripts/mergePipeline.ts, which is now
   in your editable list. Keep both files under 250 lines.

Editable files for this task: scripts/mergeTaskWorktrees.ts,
scripts/mergePipeline.ts (new), tests/mergeTaskWorktrees.test.ts. Everything else
under scripts/ remains read-only reference.
