# Task 59: Refuse tackle-tasks with a clear message in a repository that has no origin remote

Repos without an origin crash the tackle-tasks skill. When tackle-tasks is invoked in a repo without an origin, report an error to the user "this repository does not have an origin remote. set one to continue to use 'tackle-tasks'".

Observed failure, running /taskTools:tackle-tasks [3] valid in a repository with no origin remote:

  error: No such remote 'origin'
  Error: occurrence "" has an unparseable origin URL: "rootcommit:86b6e87d544536cf1d9009a3a11dd7268e4ad38e"
      at buildLogicalRepositories (scripts/logicalRepository.ts:54:19)
      at findLogicalRepository (scripts/ownershipKeys.ts:19:33)
      at computeCanonicalOwnershipKey (scripts/ownershipKeys.ts:29:31)
      at expandTaskPathEffects (scripts/ownershipKeys.ts:54:35)
      at canonicalKeysForTask (scripts/canonicalTaskGroups.ts:15:25)
      at buildCanonicalTaskGroups (scripts/canonicalTaskGroups.ts:46:61)
      at groupTasksByFileOverlap (scripts/taskGroups.ts:61:12)
      at runAsCli (scripts/prepareTasks.ts:198:20)

Root cause, verified: scripts/repositoryDiscovery.ts readOriginUrl (lines 26-37) catches the failure of `git remote get-url origin` and substitutes a synthetic identity, `rootcommit:<root commit oid>`, as the occurrence's originUrl. Its only caller is line 116. scripts/submoduleUrlIdentity.ts normalizeRepositoryIdentity (line 62) has no case for that scheme: the scp-style branch matches on the colon, leaves a single path segment, hits the `segments.length < 2` guard on line 88 and returns null. scripts/logicalRepository.ts buildLogicalRepositories (line 54) then throws on the null. Confirmed directly: normalizeRepositoryIdentity("rootcommit:86b6e87d544536cf1d9009a3a11dd7268e4ad38e") returns null while a real origin URL resolves normally.

The decision is to refuse rather than to support origin-less repositories, so do NOT teach normalizeRepositoryIdentity the rootcommit scheme. Detect the missing origin early and refuse with the exact sentence above.

The message must reach the user as a plain one-line error, not a stack trace. scripts/prepareTasks.ts runAsCli already has the right pattern at lines 190-195: it wraps selectRequestedTasks in a try/catch that writes `prepareTasks: <message>` to stderr and exits 1. The crashing calls, loadRepositoryManifest and groupTasksByFileOverlap on lines 197-198, sit outside that guard, which is why the raw trace escaped. Put the origin check where it fires before any brief or worktree is written, and route it through the same clean stderr-and-exit-1 path.

Consider whether readOriginUrl's rootcommit fallback should remain at all once the entry point refuses these repositories; if it stays, it must not be able to reach buildLogicalRepositories.

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

### tests/prepareTasks.test.ts

```
// Behavioral checks for prepareTasks.ts: brief writing, worktree creation, workflow args.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "prepare-tasks-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): { repoRoot: string; submoduleOrigin: string } {
    const submoduleOrigin = makeTempRepoWithCommit();
    writeFileSync(join(submoduleOrigin, "inner.txt"), "SUBMODULE-MARKER\n");
    git(submoduleOrigin, "add", "inner.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "inner");
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return { repoRoot, submoduleOrigin };
}

test("test_writeTaskBriefFileEmbedsTheDeclaredFileContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /MARKER-abc123/);
});

test("test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 2, title: "t2", description: "desc", files: ["missing.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /missing\.txt/);
    assert.match(text, /missing/i);
});

test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const first = createWorktreeForGroup(repoRoot, group);
    const second = createWorktreeForGroup(repoRoot, group);
    assert.equal(second, first);
});

test("test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    const sourceTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run hands a worker the same path.
    createWorktreeForGroup(repoRoot, group);
    // Verification: the worker gets the source branch tip, not the earlier run's codebase.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), sourceTip);
    assert.equal(existsSync(join(worktreePath, "fresh.txt")), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
});

test("test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees", () => {
    // Setup: a repo whose `vendor/` submodule holds a file with a known marker.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Test action: create the worktree a worker agent would be handed.
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: the submodule directory holds its files instead of being empty.
    assert.equal(existsSync(join(worktreePath, "vendor", "inner.txt")), true);
});

test("test_createWorktreeForGroupThrowsWhenSubmoduleInitFails", () => {
    // Setup: a repo with a submodule whose origin no longer exists on disk.
    const { repoRoot, submoduleOrigin } = makeTempRepoWithLocalSubmodule();
    rmSync(submoduleOrigin, { recursive: true, force: true });
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Verification: the run stops rather than handing a worker a half-populated worktree.
    assert.throws(() => createWorktreeForGroup(repoRoot, group));
});

test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});

test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("test_generateRunIdProducesDifferentValuesOnEachCall", () => {
    const first = generateRunId();
    const second = generateRunId();
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
});

test("test_mergeScriptPathPointsAtTheSiblingMergeScriptAsAnAbsolutePath", () => {
    const path = resolveMergeScriptPath();
    assert.equal(isAbsolute(path), true);
    assert.match(path, /mergeTaskWorktrees\.ts$/);
});

test("test_selectRequestedTasksRefusesToRunWhenNoTaskNumbersWereGiven", () => {
    // Setup: two open tasks and an empty requested-numbers list.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Verification: throws instead of falling back to every open task.
    assert.throws(() => selectRequestedTasks(openTasks, []), /no task numbers/i);
});

test("test_selectRequestedTasksRefusesWhenARequestedNumberIsNotOpen", () => {
    // Setup: open tasks 1 and 2, with 9 requested alongside them.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Test action and verification: the missing number is named in the error, rather than dropped.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 9]), /9/);
});

test("test_selectRequestedTasksExcludesTasksBlockedByAnOpenTask", () => {
    // Setup: task 2 is blocked by open task 1; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1], files: ["b.ts"] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: only the unblocked task survives, so no worktree is built for blocked work.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksRefusesTasksWithNoFilesArray", () => {
    // Setup: task 1 declares files, task 2 has no files key at all; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2 }];
    // Verification: the run stops and names only the undeclared task.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 2]), /\b2\b/);
});

test("test_selectRequestedTasksTreatsAnEmptyFilesArrayAsUndeclared", () => {
    // Setup: task 1 carries an explicitly empty files array.
    const openTasks = [{ taskNumber: 1, files: [] }];
    // Verification: an empty array is refused like a missing one — no ownership fence.
    assert.throws(() => selectRequestedTasks(openTasks, [1]), /files/i);
});

test("test_selectRequestedTasksIgnoresMissingFilesOnABlockedTask", () => {
    // Setup: task 2 is blocked by open task 1 and declares no files; task 1 declares files.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: the blocked task is dropped before the files check, not stopping the run.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksPointsAtTheUpdateTaskFilesSkillThatActuallyExists", () => {
    // Setup: one requested task with no files, and the skill directory on disk.
    const openTasks = [{ taskNumber: 7 }];
    // Test action: capture the refusal message.
    let message = "";
    try { selectRequestedTasks(openTasks, [7]); } catch (error) { message = (error as Error).message; }
    // Verification: message names update-task-files, and its SKILL.md exists, so the pointer can't rot.
    assert.match(message, /update-task-files/);
    assert.ok(existsSync(join(import.meta.dirname, "..", "skills", "update-task-files", "SKILL.md")));
});

test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1")), false);
});

test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});

```

### tests/repositoryDiscovery.test.ts

```
// Behavioral checks for repositoryDiscovery.ts: root-outward tree discovery + operation branches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { createEmptyResolutionManifest } from "../scripts/resolutionRequests.ts";
import { getAncestorChain } from "../scripts/repositoryGraph.ts";
import { discoverRepositoryTree } from "../scripts/repositoryDiscovery.ts";
import type { DiscoveryManifest } from "../scripts/repositoryDiscovery.ts";
import { operationBranchName, setUpOperationBranches } from "../scripts/operationBranches.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "repository-discovery-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function addSubmoduleAt(parentRepoPath: string, submoduleRelativePath: string, originPath: string): void {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(parentRepoPath, "submodule", "add", "-q", originPath, submoduleRelativePath);
    git(parentRepoPath, "commit", "-q", "-m", `add submodule ${submoduleRelativePath}`);
}

function cloneOriginInto(originPath: string, targetPath: string): void {
    execFileSync("git", ["clone", "-q", originPath, targetPath], { encoding: "utf8" });
}

function emptyDiscoveryManifest(): DiscoveryManifest {
    return {
        repositoryManifest: { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] },
        resolutionManifest: createEmptyResolutionManifest(),
    };
}

function findOccurrence(graph: RepositoryOccurrence[], occurrenceId: string): RepositoryOccurrence {
    const found = graph.find((occurrence) => occurrence.occurrenceId === occurrenceId);
    if (!found) throw new Error(`no occurrence "${occurrenceId}" in graph`);
    return found;
}

function makeThreeLevelFixture(): { rootPath: string } {
    const grandchildOrigin = makeTempRepoWithCommit();
    const childOrigin = makeTempRepoWithCommit();
    addSubmoduleAt(childOrigin, "grandchild", grandchildOrigin);

    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "child", childOrigin);
    cloneOriginInto(grandchildOrigin, join(rootPath, "child", "grandchild"));

    return { rootPath };
}

function makeJfredWithTmuxLibFixture(): { rootPath: string } {
    const tmuxLibOrigin = makeTempRepoWithCommit();
    const jfredOrigin = makeTempRepoWithCommit();
    addSubmoduleAt(jfredOrigin, "external/tmux_lib", tmuxLibOrigin);

    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "jfred", jfredOrigin);
    cloneOriginInto(tmuxLibOrigin, join(rootPath, "jfred", "external", "tmux_lib"));

    return { rootPath };
}

function makeJfredFullFixture(): { rootPath: string } {
    const tmuxLibOrigin = makeTempRepoWithCommit();
    const innerSubmoduleOrigin = makeTempRepoWithCommit();
    const jfredToolsPluginOrigin = makeTempRepoWithCommit();
    addSubmoduleAt(jfredToolsPluginOrigin, "innerSubmodule", innerSubmoduleOrigin);

    const jfredOrigin = makeTempRepoWithCommit();
    addSubmoduleAt(jfredOrigin, "external/tmux_lib", tmuxLibOrigin);
    addSubmoduleAt(jfredOrigin, "jfredToolsPlugin", jfredToolsPluginOrigin);

    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "jfred", jfredOrigin);
    cloneOriginInto(tmuxLibOrigin, join(rootPath, "jfred", "external", "tmux_lib"));
    cloneOriginInto(jfredToolsPluginOrigin, join(rootPath, "jfred", "jfredToolsPlugin"));
    cloneOriginInto(innerSubmoduleOrigin, join(rootPath, "jfred", "jfredToolsPlugin", "innerSubmodule"));

    return { rootPath };
}

function makeAmbiguousBranchFixture(): { rootPath: string } {
    const childOrigin = makeTempRepoWithCommit();
    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "child", childOrigin);
    git(join(rootPath, "child"), "branch", "release");
    return { rootPath };
}

function makeDetachedOidFixture(): { rootPath: string } {
    const childOrigin = makeTempRepoWithCommit();
    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "child", childOrigin);
    const childCheckoutPath = join(rootPath, "child");
    writeFileSync(join(childCheckoutPath, "extra.txt"), "extra\n");
    git(childCheckoutPath, "add", "extra.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "extra");
    return { rootPath };
}

test("test_discoverRootOnlyRepository_recordsRootBranchAndOidAsBase", () => {
    const rootPath = makeTempRepoWithCommit();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    assert.equal(result.graph.length, 1);
    const [root] = result.graph;
    assert.equal(root.depth, 0);
    assert.equal(root.parentOccurrenceId, null);
    assert.equal(root.baseBranch, "main");
    assert.equal(root.baseOid, git(rootPath, "rev-parse", "HEAD"));
});

test("test_discoverThreeLevelFixture_producesCorrectParentEdgesAndDepths", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    assert.equal(result.graph.length, 3);
    const root = findOccurrence(result.graph, "");
    const child = findOccurrence(result.graph, "child");
    const grandchild = findOccurrence(result.graph, "child/grandchild");
    assert.equal(root.depth, 0);
    assert.equal(root.parentOccurrenceId, null);
    assert.equal(child.depth, 1);
    assert.equal(child.parentOccurrenceId, "");
    assert.equal(grandchild.depth, 2);
    assert.equal(grandchild.parentOccurrenceId, "child");
    for (const occurrence of result.graph) assert.notEqual(occurrence.baseBranch, "");
});

test("test_discoverSubmoduleAtJfredExternalTmuxLib_recordsParentAsJfred", () => {
    const { rootPath } = makeJfredWithTmuxLibFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    const tmuxLib = findOccurrence(result.graph, "jfred/external/tmux_lib");
    assert.equal(tmuxLib.parentOccurrenceId, "jfred");
});

test("test_discoverSubmoduleBelowJfredToolsPlugin_recordsThatRepositoryAsParent", () => {
    const { rootPath } = makeJfredFullFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    const inner = findOccurrence(result.graph, "jfred/jfredToolsPlugin/innerSubmodule");
    assert.equal(inner.parentOccurrenceId, "jfred/jfredToolsPlugin");
});

test("test_discoverTree_neverRecordsSyntheticIntermediateDirectoryAsRepository", () => {
    const { rootPath } = makeJfredWithTmuxLibFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    assert.equal(
        result.graph.some((occurrence) => occurrence.occurrenceId === "jfred/external"),
        false,
    );
});

test("test_discoverTreeWithAmbiguousBranchTip_returnsResolutionRequestNotGraph", () => {
    const { rootPath } = makeAmbiguousBranchFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "needsResolution");
    if (result.status !== "needsResolution") return;
    assert.equal(result.resolutionRequests.length, 1);
    assert.equal(result.resolutionRequests[0].occurrenceId, "child");
});

test("test_discoverTreeWithDetachedOid_returnsResolutionRequestNotGraph", () => {
    const { rootPath } = makeDetachedOidFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "needsResolution");
    if (result.status !== "needsResolution") return;
    assert.equal(result.resolutionRequests.length, 1);
    assert.equal(result.resolutionRequests[0].occurrenceId, "child");
});

test("test_discoverTreeWithUnresolvedRepository_stopsBeforeCreatingOperationBranches", () => {
    const { rootPath } = makeAmbiguousBranchFixture();
    const manifest = emptyDiscoveryManifest();
    discoverRepositoryTree(rootPath, manifest);
    for (const occurrence of manifest.repositoryManifest.occurrences) {
        assert.equal(occurrence.operationBranch, "");
    }
});

test("test_discoverRepositoryTree_createsNoNewBranches", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const checkoutPaths = [rootPath, join(rootPath, "child"), join(rootPath, "child", "grandchild")];
    const branchesBefore = checkoutPaths.map((path) => git(path, "branch", "--list"));

    const result = discoverRepositoryTree(rootPath, manifest);

    assert.equal(result.status, "resolved");
    checkoutPaths.forEach((path, index) => {
        assert.equal(git(path, "branch", "--list"), branchesBefore[index]);
    });
});

test("test_discoverRepositoryTree_leavesCurrentBranchUnchanged", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const checkoutPaths = [rootPath, join(rootPath, "child"), join(rootPath, "child", "grandchild")];
    const currentBranchesBefore = checkoutPaths.map((path) => git(path, "branch", "--show-current"));

    discoverRepositoryTree(rootPath, manifest);

    checkoutPaths.forEach((path, index) => {
        assert.equal(git(path, "branch", "--show-current"), currentBranchesBefore[index]);
    });
});

test("test_discoverRepositoryTree_leavesOperationBranchEmptyOnResolvedOccurrences", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    for (const occurrence of result.graph) {
        assert.equal(occurrence.operationBranch, "");
    }
});

test("test_resumedDiscoveryRun_reusesPersistedAnswerWithoutReResolving", () => {
    const { rootPath } = makeAmbiguousBranchFixture();
    const manifest = emptyDiscoveryManifest();
    const firstResult = discoverRepositoryTree(rootPath, manifest);
    assert.equal(firstResult.status, "needsResolution");
    if (firstResult.status !== "needsResolution") return;
    const request = firstResult.resolutionRequests[0];
    manifest.resolutionManifest.resolutionAnswers[request.id] = request.candidateBaseBranches[0];

    const secondResult = discoverRepositoryTree(rootPath, manifest);
    assert.equal(secondResult.status, "resolved");
    if (secondResult.status !== "resolved") return;
    const child = findOccurrence(secondResult.graph, "child");
    assert.equal(child.baseBranch, request.candidateBaseBranches[0]);
});

test("test_resumedDiscoveryRun_doesNotRecreateCompletedOperationBranches", () => {
    const { rootPath } = makeThreeLevelFixture();
    const manifest = emptyDiscoveryManifest();
    const firstResult = discoverRepositoryTree(rootPath, manifest);
    assert.equal(firstResult.status, "resolved");
    if (firstResult.status !== "resolved") return;

    const child = findOccurrence(firstResult.graph, "child");
    git(child.checkoutPath, "checkout", "-q", child.baseBranch);
    const branchAfterManualCheckout = git(child.checkoutPath, "branch", "--show-current");

    const secondResult = discoverRepositoryTree(rootPath, manifest);
    assert.equal(secondResult.status, "resolved");
    if (secondResult.status !== "resolved") return;

    assert.equal(git(child.checkoutPath, "branch", "--show-current"), branchAfterManualCheckout);
});

test("test_discoverUniqueDeeplyNestedTree_isReadyForDryRunIntegration", () => {
    const { rootPath } = makeJfredFullFixture();
    const manifest = emptyDiscoveryManifest();
    const result = discoverRepositoryTree(rootPath, manifest);
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;

    assert.equal(result.graph.length, 5);

    const runId = "dry-run-integration";
    const branchedOccurrences = setUpOperationBranches(result.graph, runId);
    for (const occurrence of branchedOccurrences) {
        assert.equal(occurrence.operationBranch, operationBranchName(runId, occurrence));
    }

    const innerSubmodule = findOccurrence(result.graph, "jfred/jfredToolsPlugin/innerSubmodule");
    const ancestorIds = getAncestorChain(innerSubmodule, manifest.repositoryManifest).map(
        (occurrence) => occurrence.occurrenceId,
    );
    assert.deepEqual(ancestorIds, ["jfred/jfredToolsPlugin", "jfred", ""]);
});

```
