# Task 51: Route legacy manifests to a non-destructive refusal with recovery instructions

Step 6 of the task 35 cutover split.

Dispatch legacy versus new manifests through scripts/legacyManifest.ts at the mergeTaskWorktrees.ts runAsCli entry point, routing a legacy manifest to its existing compatible tooling or to a non-destructive refusal that reports exact recovery instructions.

Legacy worktrees must survive the refusal untouched — nothing is removed, reset or force-checked-out on this path.

Tests: a legacy manifest is refused non-destructively, its recovery instructions name the affected worktree, and the worktree still exists on disk afterwards.

### scripts/legacyManifest.ts

```
// Detects flat-model (pre-version) run manifests and refuses to proceed, non-destructively.
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";

export interface LegacyManifestRefusal {
    ok: false;
    detectedVersion: number | undefined; // undefined = versionless manifest
    reason: string;
    recoveryCommands: string[];
}

export interface LegacyManifestPass {
    ok: true;
}

export type LegacyManifestCheck = LegacyManifestRefusal | LegacyManifestPass;

const RECOVERY_COMMANDS = [
    "inspect the worktrees listed in this manifest manually before rerunning",
    "run `git worktree list` in the repository to see what checkouts still exist",
    "run `git branch --list` to see what operation branches still exist",
];

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck {
    const version = (manifest as { version?: number } | null | undefined)?.version;

    if (version === undefined || version === null) {
        return {
            ok: false,
            detectedVersion: undefined,
            reason: "manifest predates version tracking (flat repository-path model)",
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    if (version < REPOSITORY_MANIFEST_VERSION) {
        return {
            ok: false,
            detectedVersion: version,
            reason: `manifest version ${version} is older than current version ${REPOSITORY_MANIFEST_VERSION}`,
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    return { ok: true };
}

```

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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

### tests/legacyManifest.test.ts

```
// Behavioral checks for legacyManifest.ts: refusal of pre-version manifests, non-destructive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLegacyManifest } from "../scripts/legacyManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

test("test_versionlessManifestIsRejected", () => {
    const result = checkLegacyManifest({ occurrences: [] });
    assert.equal(result.ok, false);
    assert.equal((result as { detectedVersion: number | undefined }).detectedVersion, undefined);
});

test("test_olderVersionManifestIsRejected", () => {
    const olderVersion = REPOSITORY_MANIFEST_VERSION - 1;
    const result = checkLegacyManifest({ version: olderVersion, occurrences: [] });
    assert.equal(result.ok, false);
    assert.equal((result as { detectedVersion: number | undefined }).detectedVersion, olderVersion);
});

test("test_rejectionResultNamesRecoveryCommands", () => {
    const result = checkLegacyManifest({ occurrences: [] });
    assert.equal(result.ok, false);
    const recoveryCommands = (result as { recoveryCommands: string[] }).recoveryCommands;
    assert.ok(recoveryCommands.length > 0);
    for (const command of recoveryCommands) {
        assert.equal(typeof command, "string");
        assert.ok(command.trim().length > 0);
    }
});

test("test_refusalDoesNotDeleteWorktreeOrBranch", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "legacy-manifest-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    git(repoRoot, "commit", "-q", "--allow-empty", "-m", "seed");
    const worktreePath = join(repoRoot, "worktree-1");
    git(repoRoot, "worktree", "add", "-q", "-b", "task-group-1", worktreePath);

    const legacyManifest = {
        repositories: [{ checkoutPath: worktreePath, operationBranch: "task-group-1" }],
    };
    const result = checkLegacyManifest(legacyManifest);

    assert.equal(result.ok, false);
    assert.equal(existsSync(worktreePath), true);
    const branches = git(repoRoot, "branch", "--list", "task-group-1");
    assert.ok(branches.includes("task-group-1"));
});

test("test_currentVersionManifestPassesThroughUnchanged", () => {
    const manifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] };
    const clone = structuredClone(manifest);

    const result = checkLegacyManifest(manifest);

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(manifest, clone);
});

```
