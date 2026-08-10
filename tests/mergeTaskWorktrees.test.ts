// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest, type RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";
import type { ArchiveRequest } from "../scripts/taskArchival.ts";
import type { DiscoveryManifest } from "../scripts/repositoryDiscovery.ts";
import type { ResolutionManifest } from "../scripts/resolutionRequests.ts";
import {
    defaultMergeStepOperations,
    listTaskWorktrees,
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    mergeTaskDeepestFirst,
    rebaseGroupOntoSource,
    rebaseParentOntoSourceAndTest,
    rebaseSubmoduleLayersDeepestFirst,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";
import type { MergeStepOperations } from "../scripts/mergeTaskWorktrees.ts";
import { REASON_NO_TEST_CONFIGURATION } from "../scripts/testPolicy.ts";

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
    return { groupId, worktree, branch: `task-${groupId}`, scope: "unknown", tasks: [] };
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

function makeOccurrence(
    occurrenceId: string,
    parentOccurrenceId: string | null,
    baseBranch: string,
    baseOid: string,
    operationBranch: string,
    sourceCheckoutPath: string,
): RepositoryOccurrence {
    return {
        occurrenceId,
        checkoutPath: sourceCheckoutPath,
        parentOccurrenceId,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "",
        baseBranch,
        baseOid,
        operationBranch,
        childOccurrenceIds: [],
        testState: "untested" as const,
    };
}

function emptyResolutionManifest(): ResolutionManifest {
    return { resolutionRequests: [], resolutionAnswers: {}, baseReconciliationRequests: [], baseReconciliationAnswers: {} };
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

test("test_noEvidenceCausesNoFinalizationMutation", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.runState.readyForApproval, false);
    assert.equal(output.runState.approval, undefined);
    assert.equal(output.runState.authorization, undefined);
    assert.deepEqual(output.publicationTargets, []);
    assert.equal(git(repoRoot, "rev-parse", sourceBranch).trim(), preMergeBaseOid);
    const refs = git(repoRoot, "for-each-ref", "--format=%(refname)").split("\n");
    assert.equal(refs.some((ref) => ref.startsWith("refs/finalize/")), false);
    assert.equal(refs.some((ref) => ref.startsWith("refs/heads/operations/")), false);
    assert.deepEqual(refs.filter((ref) => ref.startsWith("refs/heads/") && ref !== `refs/heads/${sourceBranch}` && ref !== `refs/heads/${group.branch}`), []);
});

test("test_productionShapedNestedFinalizationSucceeds", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const rootPath = makeTempRepoWithCommit();
    const submoduleSourcePath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", submoduleSourcePath, "vendor");
    git(rootPath, "commit", "-q", "-m", "add submodule");

    const bootstrapResult = bootstrapRepositoryManifest(rootPath);
    assert.equal(bootstrapResult.refused, false);
    const occurrenceGraph = bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph;
    const manifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: occurrenceGraph };
    const rootOccurrence = occurrenceGraph.find((o) => o.parentOccurrenceId === null)!;
    assert.equal(rootOccurrence.operationBranch, "");
    assert.ok(rootOccurrence.checkoutPath.startsWith("/"));

    const sourceBranch = currentBranchName(rootPath);
    const submodulePath = join(rootPath, "vendor");
    const submoduleSourceBranch = currentBranchName(submodulePath);
    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");

    const preMergeRootOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const preMergeSubmoduleOid = git(submodulePath, "rev-parse", submoduleSourceBranch).trim();

    const cliInput = {
        repo: rootPath,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: manifest,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.deepEqual(
        Object.keys(output).sort(),
        ["merged", "conflicts", "testReceipts", "reviewHandoffs", "occurrenceDigests", "runState", "publicationTargets", "abortReason", "archiveRequest"].sort(),
    );
    assert.equal(output.runState.readyForApproval, true);

    const postMergeRootOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const postMergeSubmoduleOid = git(submodulePath, "rev-parse", submoduleSourceBranch).trim();
    const rootTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "");
    const subTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "vendor");
    assert.equal(rootTarget.targetOid, postMergeRootOid);
    assert.equal(subTarget.targetOid, postMergeSubmoduleOid);

    assert.doesNotThrow(() => git(rootPath, "merge-base", "--is-ancestor", preMergeRootOid, postMergeRootOid));
    assert.doesNotThrow(() => git(submodulePath, "merge-base", "--is-ancestor", preMergeSubmoduleOid, postMergeSubmoduleOid));

    const rootGitlinkOid = git(rootPath, "ls-tree", sourceBranch, "vendor").trim().split(/\s+/)[2];
    assert.equal(rootGitlinkOid, postMergeSubmoduleOid);

    const refs = git(rootPath, "for-each-ref", "--format=%(refname)").split("\n");
    assert.ok(refs.some((ref) => ref.startsWith("refs/finalize/")));

    assert.equal(existsSync(group.worktree), true);
    const branches = git(rootPath, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});

// Root + submodule fixture carrying a real task number, a seeded task file, and the three run-input files.
function buildNestedFixtureWithTask(taskNumber: number) {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const rootPath = makeTempRepoWithCommit();
    const submoduleSourcePath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", submoduleSourcePath, "vendor");
    git(rootPath, "commit", "-q", "-m", "add submodule");

    const bootstrapResult = bootstrapRepositoryManifest(rootPath);
    assert.equal(bootstrapResult.refused, false);
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph,
    };

    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(join(rootPath, "vendor"));
    const taskFiles = ["new.txt", "vendor/vendor-new.txt"];
    const group = makeGroup(rootPath, 1);
    group.tasks = [{ number: taskNumber, briefFile: "", planFile: "", files: taskFiles }];
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(group.worktree, "vendor", "vendor-new.txt"), "vendor new\n");
    git(join(group.worktree, "vendor"), "add", "vendor-new.txt");
    git(join(group.worktree, "vendor"), "commit", "-q", "-m", "add vendor-new.txt");

    const taskToolsDir = join(rootPath, ".taskTools");
    mkdirSync(taskToolsDir, { recursive: true });
    writeFileSync(
        join(taskToolsDir, "tasks.json"),
        JSON.stringify([{ taskNumber, title: "t", description: "d", files: taskFiles, difficulty: 1, blockedBy: [] }]) + "\n",
    );
    writeFileSync(join(taskToolsDir, "completedTasks.json"), "[]\n");
    const runFiles = [resolveRunArgumentsPath(rootPath), resolveRunOutcomesPath(rootPath), resolveStepOutputsPath(rootPath)];
    for (const path of runFiles) writeFileSync(path, "{}\n");

    const cliInput = {
        repo: rootPath,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: manifest,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    return { rootPath, cliInput, runFiles, taskToolsDir };
}

function runPipelineCli(cliInput: unknown): { publicationTargets: unknown[]; archiveRequest: ArchiveRequest | null } {
    return JSON.parse(execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" }));
}

function readTaskNumbers(taskToolsDir: string, fileName: string): number[] {
    return JSON.parse(readFileSync(join(taskToolsDir, fileName), "utf8")).map((task: { taskNumber: number }) => task.taskNumber);
}

// Task 112: pipeline no longer archives; it emits archiveRequest for a later step to act on.
test("test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessEmitsArchiveRequest", () => {
    // Another writer moves the base ref after the manifest is captured, so publication must refuse.
    const raced = buildNestedFixtureWithTask(9101);
    writeFileSync(join(raced.rootPath, "raced.txt"), "another writer\n");
    git(raced.rootPath, "add", "raced.txt");
    git(raced.rootPath, "commit", "-q", "-m", "someone else moved the base");

    const racedOutput = runPipelineCli(raced.cliInput);
    assert.deepEqual(racedOutput.publicationTargets, []);
    assert.equal(racedOutput.archiveRequest, null);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "tasks.json"), [9101]);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "completedTasks.json"), []);
    for (const path of raced.runFiles) assert.equal(existsSync(path), true);

    // Nothing races the base ref, so publication succeeds; the pipeline still leaves archiving to the caller.
    const clean = buildNestedFixtureWithTask(9102);
    const cleanOutput = runPipelineCli(clean.cliInput);
    assert.notDeepEqual(cleanOutput.publicationTargets, []);
    assert.deepEqual(cleanOutput.archiveRequest?.publishedTaskNumbers, [9102]);
    assert.equal(cleanOutput.archiveRequest?.mergeResults.length, 1);
    assert.equal(cleanOutput.archiveRequest?.mergeResults[0].taskNumber, 9102);
    assert.equal(cleanOutput.archiveRequest?.mergeResults[0].fullyPublished, true);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "tasks.json"), [9102]);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "completedTasks.json"), []);
    for (const path of clean.runFiles) assert.equal(existsSync(path), false);
});

function gitPathExists(worktreePath: string, relativePath: string): boolean {
    const raw = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    const full = isAbsolute(raw) ? raw : join(worktreePath, raw);
    return existsSync(full);
}

test("test_rebaseGroupOntoSourceReportsRebasedCleanForANonConflictingRebase", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group.txt"), "group work\n");
    git(group.worktree, "add", "group.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    writeFileSync(join(repoRoot, "main.txt"), "main advance\n");
    git(repoRoot, "add", "main.txt");
    git(repoRoot, "commit", "-q", "-m", "advance main");

    const outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    assert.deepEqual(outcome, { status: "rebased-clean" });
});

test("test_rebaseGroupOntoSourceReportsConflictedPathsAndLeavesNoRebaseInProgress", () => {
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

    const outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    assert.deepEqual(outcome, { status: "conflicted", conflictedFilePaths: ["shared.txt"] });
    assert.equal(gitPathExists(group.worktree, "rebase-merge"), false);
    assert.equal(gitPathExists(group.worktree, "rebase-apply"), false);
});

test("test_rebaseGroupOntoSourceReportsCleanupFailedWhenAbortFails", () => {
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

    // Only intercepts abortRebase's "-C <worktree> rebase --abort"; the earlier real rebase call above still hits real git.
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), "fake-git-"));
    const shimPath = join(shimDir, "git");
    writeFileSync(
        shimPath,
        [
            "#!/bin/sh",
            'if [ "$1" = "-C" ] && [ "$3" = "rebase" ] && [ "$4" = "--abort" ]; then',
            '  echo "fake abort failure" >&2',
            "  exit 1",
            "fi",
            `exec "${realGit}" "$@"`,
            "",
        ].join("\n"),
    );
    execFileSync("chmod", ["+x", shimPath]);

    const originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath}`;
    let outcome;
    try {
        outcome = rebaseGroupOntoSource(group.worktree, sourceBranch);
    } finally {
        process.env.PATH = originalPath;
    }

    assert.equal(outcome.status, "cleanup-failed");
    if (outcome.status === "cleanup-failed") assert.match(outcome.failureReason, /abort also failed: fake abort failure/);
});

test("test_rebaseGroupOntoSourceRebasesABranchInsideASubmodule", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");

    writeFileSync(join(worktreeSubmodulePath, "vendor-work.txt"), "vendor work\n");
    git(worktreeSubmodulePath, "add", "vendor-work.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "vendor work");

    writeFileSync(join(mainSubmodulePath, "main-advance.txt"), "main advance\n");
    git(mainSubmodulePath, "add", "main-advance.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "advance main submodule");
    git(worktreeSubmodulePath, "fetch", mainSubmodulePath, `${submoduleSourceBranch}:${submoduleSourceBranch}`);

    const outcome = rebaseGroupOntoSource(worktreeSubmodulePath, submoduleSourceBranch);
    assert.deepEqual(outcome, { status: "rebased-clean" });
    assert.doesNotThrow(() => git(worktreeSubmodulePath, "merge-base", "--is-ancestor", submoduleSourceBranch, "HEAD"));
});

test("test_rebaseSubmoduleLayersDeepestFirstTreatsASubmoduleAlreadyOnItsSourceTipAsANoOp", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const submoduleOperationBranch = currentBranchName(worktreeSubmodulePath);

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", submoduleSourceBranch, submoduleBaseOid, submoduleOperationBranch, mainSubmodulePath)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(group.worktree, manifest);

    assert.deepEqual(report.completedLayers, [{ occurrenceId: "vendor", checkoutPath: worktreeSubmodulePath, status: "no-op" }]);
    assert.equal(report.stoppedAt, null);
});

test("test_rebaseSubmoduleLayersDeepestFirstRebasesTheDeepestSubmoduleBeforeItsContainerAndRecordsItsRebasedGitlink", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const testScriptPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(join(innerOrigin, "package.json"), testScriptPackageJson);
    git(innerOrigin, "add", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), testScriptPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitBeforeRebase = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Reproduce the real starting state: parent's task branch already records child's pre-rebase gitlink.
    git(vendorCheckoutPath, "add", "inner");
    git(vendorCheckoutPath, "commit", "-q", "-m", "bump inner to task-1 work");

    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    // Advance both source branches independently, after the task branches already diverged.
    writeFileSync(join(innerOrigin, "inner-source-advance.txt"), "inner source advance\n");
    git(innerOrigin, "add", "inner-source-advance.txt");
    git(innerOrigin, "commit", "-q", "-m", "advance inner source");
    const innerSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    writeFileSync(join(vendorOrigin, "vendor-source-advance.txt"), "vendor source advance\n");
    git(vendorOrigin, "add", "vendor-source-advance.txt");
    git(vendorOrigin, "commit", "-q", "-m", "advance vendor source");
    const vendorSourceTip = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested", "rebased-and-tested"]);

    // Both task branches were rebased onto their freshly-fetched (post-advance) source tips.
    assert.doesNotThrow(() => git(innerCheckoutPath, "merge-base", "--is-ancestor", innerSourceTip, "HEAD"));
    assert.doesNotThrow(() => git(vendorCheckoutPath, "merge-base", "--is-ancestor", vendorSourceTip, "HEAD"));

    const innerTaskCommitAfterRebase = git(innerCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(innerTaskCommitAfterRebase, innerTaskCommitBeforeRebase);

    // vendor's task-1 branch now records inner's rebased commit, not its pre-rebase one.
    const vendorRecordedInnerOid = git(vendorCheckoutPath, "rev-parse", "task-1:inner").trim();
    assert.equal(vendorRecordedInnerOid, innerTaskCommitAfterRebase);
});

test("test_rebaseSubmoduleLayersDeepestFirstRecordsAndTestsAContainerWhoseOwnRefsAreIdenticalButWhoseChildGitlinkChanged", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const testScriptPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(join(innerOrigin, "package.json"), testScriptPackageJson);
    git(innerOrigin, "add", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), testScriptPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    // vendor's task-1 gets no commit of its own: it stays at vendorSourceBranch's tip, refs trivially identical.
    const vendorTaskCommitBeforeWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitBeforeWalk, vendorBaseOid);

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitBeforeRebase = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Only inner's source advances; vendor's own source is left untouched, so vendor's task-1 and source stay identical.
    writeFileSync(join(innerOrigin, "inner-source-advance.txt"), "inner source advance\n");
    git(innerOrigin, "add", "inner-source-advance.txt");
    git(innerOrigin, "commit", "-q", "-m", "advance inner source");
    const innerSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    // Confirm the precondition the fix targets: vendor's own task-1 and source are identical before the walk runs.
    assert.equal(git(vendorCheckoutPath, "rev-list", "--count", `${vendorSourceBranch}..task-1`).trim(), "0");
    assert.equal(git(vendorCheckoutPath, "rev-list", "--count", `task-1..${vendorSourceBranch}`).trim(), "0");

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested", "rebased-and-tested"]);

    const innerTaskCommitAfterRebase = git(innerCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(innerTaskCommitAfterRebase, innerTaskCommitBeforeRebase);
    assert.doesNotThrow(() => git(innerCheckoutPath, "merge-base", "--is-ancestor", innerSourceTip, "HEAD"));

    // vendor's own refs were identical, yet it still recorded inner's commit and tested, not "no-op".
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.notEqual(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
    const vendorRecordedInnerOid = git(vendorCheckoutPath, "rev-parse", "task-1:inner").trim();
    assert.equal(vendorRecordedInnerOid, innerTaskCommitAfterRebase);
});

test("test_rebaseSubmoduleLayersDeepestFirstStopsAndReportsBothOutputStreamsWhenALayersTestsFailWithoutProcessingItsContainer", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const passingTestPackageJson = JSON.stringify({ scripts: { test: "true" } });

    const innerOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(innerOrigin, "test-fail.js"),
        "console.log('layer-stdout-marker');\nconsole.error('layer-stderr-marker');\nprocess.exit(1);\n",
    );
    writeFileSync(join(innerOrigin, "package.json"), JSON.stringify({ scripts: { test: "node test-fail.js" } }));
    git(innerOrigin, "add", "test-fail.js", "package.json");
    git(innerOrigin, "commit", "-q", "-m", "add failing test script");
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(join(vendorOrigin, "package.json"), passingTestPackageJson);
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add test script");
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");

    const vendorTaskCommitBeforeWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.deepEqual(report.completedLayers, []);
    assert.equal(report.stoppedAt !== null && report.stoppedAt.occurrenceId, "vendor/inner");
    assert.equal(report.stoppedAt !== null && report.stoppedAt.status, "tests-failed");
    if (report.stoppedAt !== null && report.stoppedAt.status === "tests-failed") {
        assert.equal(report.stoppedAt.failedCheck, "complete-suite");
        assert.match(report.stoppedAt.testOutput, /layer-stdout-marker/);
        assert.match(report.stoppedAt.testOutput, /layer-stderr-marker/);
    }

    // vendor (inner's container) was never rebased: its task-1 branch is exactly as it was.
    const vendorTaskCommitAfterWalk = git(vendorCheckoutPath, "rev-parse", "task-1").trim();
    assert.equal(vendorTaskCommitAfterWalk, vendorTaskCommitBeforeWalk);
});

test("test_rebaseParentOntoSourceAndTestResolvesAnAllowedGitlinkConflictAndReportsRebasedAndTested", () => {
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
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer and test config");

    git(repoRoot, "checkout", "feature");
    // Intended resolution: keep feature's already-rebased submodule commit.
    git(mainSubmodulePath, "checkout", commitA);

    const outcome = rebaseParentOntoSourceAndTest("root", repoRoot, baseBranch, ["vendor"], emptyResolutionManifest());

    assert.deepEqual(outcome, { status: "rebased-and-tested" });
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-merge")), false);
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-apply")), false);
    const rootGitlinkOid = git(repoRoot, "ls-tree", "feature", "vendor").trim().split(/\s+/)[2];
    assert.equal(rootGitlinkOid, commitA);
});

test("test_rebaseParentOntoSourceAndTestRebasesThenRunsTheParentsOwnTestCommandAndReportsRebasedAndTested", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "add test script");
    const sourceBranch = currentBranchName(repoRoot);

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group-work.txt"), "group work\n");
    git(group.worktree, "add", "group-work.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    writeFileSync(join(repoRoot, "main-advance.txt"), "main advance\n");
    git(repoRoot, "add", "main-advance.txt");
    git(repoRoot, "commit", "-q", "-m", "advance main");

    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest());

    assert.deepEqual(outcome, { status: "rebased-and-tested" });
    assert.doesNotThrow(() => git(group.worktree, "merge-base", "--is-ancestor", sourceBranch, "HEAD"));
});

test("test_rebaseParentOntoSourceAndTestReportsUntestedWhenTheParentHasNoTestConfiguration", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const markerPath = join(group.worktree, "typecheck-marker.txt");
    const typecheckCommand = `node -e "require('fs').writeFileSync('${markerPath}','ran')"`;
    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest(), false, typecheckCommand);

    assert.equal(outcome.status, "untested");
    assert.equal(readFileSync(markerPath, "utf8"), "ran");
});

test("test_rebaseParentOntoSourceAndTestReportsTestsFailedWhenTheTypecheckCommandFails", () => {
    const repoRoot = makeTempRepoWithCommit();
    const suiteMarkerPath = join(repoRoot, "suite-ran.txt");
    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('${suiteMarkerPath}','yes')"` } }));
    git(repoRoot, "add", "package.json");
    git(repoRoot, "commit", "-q", "-m", "add test script");
    const sourceBranch = currentBranchName(repoRoot);

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "group-work.txt"), "group work\n");
    git(group.worktree, "add", "group-work.txt");
    git(group.worktree, "commit", "-q", "-m", "group work");

    // "false" is a typecheck command that always fails.
    const outcome = rebaseParentOntoSourceAndTest("root", group.worktree, sourceBranch, [], emptyResolutionManifest(), false, "false");

    assert.equal(outcome.status, "tests-failed");
    assert.equal((outcome as { failedCheck: string }).failedCheck, "typecheck");
    assert.equal(existsSync(suiteMarkerPath), false);
});

test("test_rebaseSubmoduleLayersDeepestFirstRunsTheSubmodulesOwnTestCommandNotTheParents", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(
        join(rootPath, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','parent-ran')\"" } }),
    );
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.stoppedAt, null);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["rebased-and-tested"]);
    assert.equal(readFileSync(join(vendorCheckoutPath, "test-marker.txt"), "utf8"), "submodule-ran");
});

test("test_rebaseSubmoduleLayersDeepestFirstReportsTestsFailedWhenTheTypecheckCommandFailsEvenThoughTheSuiteWouldPass", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    const vendorOrigin = makeTempRepoWithCommit();
    writeFileSync(
        join(vendorOrigin, "package.json"),
        JSON.stringify({ scripts: { test: "node -e \"require('fs').writeFileSync('test-marker.txt','submodule-ran')\"" } }),
    );
    git(vendorOrigin, "add", "package.json");
    git(vendorOrigin, "commit", "-q", "-m", "add submodule test script");
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest, false, "false");

    assert.notEqual(report.stoppedAt, null);
    assert.equal(report.stoppedAt !== null && report.stoppedAt.status, "tests-failed");
    if (report.stoppedAt !== null && report.stoppedAt.status === "tests-failed") {
        assert.equal(report.stoppedAt.failedCheck, "typecheck");
    }
    assert.equal(existsSync(join(vendorCheckoutPath, "test-marker.txt")), false);
});

test("test_rebaseSubmoduleLayersDeepestFirstReportsUntestedWhenTheSubmoduleHasNoTestConfigurationEvenThoughTheParentDoes", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const rootPath = makeTempRepoWithCommit();
    writeFileSync(join(rootPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(rootPath, "add", "package.json");
    git(rootPath, "commit", "-q", "-m", "add parent test script");

    const vendorOrigin = makeTempRepoWithCommit();
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");

    const vendorCheckoutPath = join(rootPath, "vendor");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [makeOccurrence("vendor", "", vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin)],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const report = rebaseSubmoduleLayersDeepestFirst(rootPath, manifest);

    assert.equal(report.completedLayers.length, 0);
    assert.notEqual(report.stoppedAt, null);
    assert.equal(report.stoppedAt?.status, "untested");
    const untestedOutcome = report.stoppedAt as { status: "untested"; resolutionRequests: { reason: string }[] };
    assert.equal(untestedOutcome.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
});

test("test_rebaseGroupOntoSourceAbortsAndReportsCleanupFailedWhenStagingAnAllowedConflictFails", () => {
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

    git(repoRoot, "checkout", "feature");
    // Delete the submodule's working directory so `git add vendor` has no path to stage and throws.
    execFileSync("rm", ["-rf", mainSubmodulePath]);

    const outcome = rebaseGroupOntoSource(repoRoot, baseBranch, ["vendor"]);

    assert.equal(outcome.status, "cleanup-failed");
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-merge")), false);
    assert.equal(existsSync(join(repoRoot, ".git", "rebase-apply")), false);
});

// Root's real occurrenceId is "" (repositoryDiscovery.ts:84), not "root"; reports relabel it for readability.
const ROOT_OCCURRENCE_ID = "";

// mergeTaskDeepestFirst runs discoverTestPolicy per occurrence; without a "test" script it needs a resolution answer instead.
function addPassingTestScript(repoPath: string): void {
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "add test script");
}

// A worktree clones from origin, not this checkout, so the commit must land there.
function addPassingTestScriptToSubmoduleOrigin(mainSubmodulePath: string): void {
    const originUrl = git(mainSubmodulePath, "remote", "get-url", "origin").trim();
    const branch = currentBranchName(mainSubmodulePath);
    addPassingTestScript(originUrl);
    git(mainSubmodulePath, "fetch", "-q", "origin");
    git(mainSubmodulePath, "merge", "--ff-only", "-q", `origin/${branch}`);
}

function buildMergePrimitiveFixture(): {
    rootPath: string;
    mainSubmodulePath: string;
    sourceBranch: string;
    submoduleSourceBranch: string;
    group: PreparedGroup;
    worktreeSubmodulePath: string;
    discoveryManifest: DiscoveryManifest;
} {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    addPassingTestScriptToSubmoduleOrigin(mainSubmodulePath);
    git(rootPath, "add", "vendor");
    git(rootPath, "commit", "-q", "-m", "bump vendor gitlink for test script");
    addPassingTestScript(rootPath);
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    return {
        rootPath,
        mainSubmodulePath,
        sourceBranch,
        submoduleSourceBranch,
        group,
        worktreeSubmodulePath,
        discoveryManifest: { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() },
    };
}

// Commits submodule work, then a later separate commit bumps the parent's gitlink so the merge sees it.
function commitSubmoduleWorkAndBumpParentGitlink(fixture: { group: PreparedGroup; worktreeSubmodulePath: string }): string {
    writeFileSync(join(fixture.worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(fixture.worktreeSubmodulePath, "add", "vendor-new.txt");
    git(fixture.worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");
    const vendorTaskCommitOid = git(fixture.worktreeSubmodulePath, "rev-parse", "HEAD").trim();

    git(fixture.group.worktree, "add", "vendor");
    git(fixture.group.worktree, "commit", "-q", "-m", "bump vendor gitlink");

    return vendorTaskCommitOid;
}

test("test_mergeTaskDeepestFirstMergesTheSubmoduleBeforeTheParentAndProvesReachabilityAtParentEntry", () => {
    const fixture = buildMergePrimitiveFixture();
    const vendorTaskCommitOid = commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const invocationOrder: string[] = [];
    const reachabilityAtParentEntry = { checked: false, reachable: false };
    const gitlinkAtParentEntry = { recorded: "", childSourceTip: "" };
    const wrappedMergeSubmodule: MergeStepOperations["mergeSubmodule"] = (mainSubmodulePath, worktreeSubmodulePath, sourceBranch) => {
        invocationOrder.push("submodule");
        return mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    };
    const wrappedMergeGroup: MergeStepOperations["mergeGroup"] = (repoRoot, group, sourceBranch, submodulePaths) => {
        invocationOrder.push("parent");
        reachabilityAtParentEntry.checked = true;
        try {
            git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", vendorTaskCommitOid, fixture.submoduleSourceBranch);
            reachabilityAtParentEntry.reachable = true;
        } catch {
            reachabilityAtParentEntry.reachable = false;
        }
        // Propagation must already have run: the parent task branch records M, not T.
        gitlinkAtParentEntry.recorded = git(fixture.group.worktree, "rev-parse", "HEAD:vendor").trim();
        gitlinkAtParentEntry.childSourceTip = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
        return mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths);
    };

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest, {
        mergeSubmodule: wrappedMergeSubmodule,
        mergeGroup: wrappedMergeGroup,
    });

    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor", "root"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged", "merged"]);
    assert.deepEqual(invocationOrder, ["submodule", "parent"]);
    assert.equal(reachabilityAtParentEntry.checked, true);
    assert.equal(reachabilityAtParentEntry.reachable, true);
    assert.equal(gitlinkAtParentEntry.recorded, gitlinkAtParentEntry.childSourceTip);
    assert.notEqual(gitlinkAtParentEntry.recorded, vendorTaskCommitOid);
});

test("test_mergeTaskDeepestFirstMergesGrandchildThenChildThenParentAndProvesReachabilityAtEachContainingEntry", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";

    const innerOrigin = makeTempRepoWithCommit();
    addPassingTestScript(innerOrigin);
    const innerSourceBranch = currentBranchName(innerOrigin);
    const innerBaseOid = git(innerOrigin, "rev-parse", innerSourceBranch).trim();

    const vendorOrigin = makeTempRepoWithCommit();
    git(vendorOrigin, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendorOrigin, "commit", "-q", "-m", "add inner submodule");
    addPassingTestScript(vendorOrigin);
    const vendorSourceBranch = currentBranchName(vendorOrigin);
    const vendorBaseOid = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();

    const rootPath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(rootPath, "submodule", "update", "--init", "--recursive", "-q");
    git(rootPath, "commit", "-q", "-m", "add vendor submodule");
    addPassingTestScript(rootPath);
    const rootSourceBranch = currentBranchName(rootPath);
    const rootBaseOid = git(rootPath, "rev-parse", rootSourceBranch).trim();

    const vendorCheckoutPath = join(rootPath, "vendor");
    const innerCheckoutPath = join(rootPath, "vendor", "inner");
    git(vendorCheckoutPath, "checkout", "-q", vendorSourceBranch);
    git(innerCheckoutPath, "checkout", "-q", innerSourceBranch);

    git(rootPath, "checkout", "-q", "-b", "task-1");
    git(vendorCheckoutPath, "checkout", "-q", "-b", "task-1");
    git(innerCheckoutPath, "checkout", "-q", "-b", "task-1");

    writeFileSync(join(innerCheckoutPath, "inner-work.txt"), "inner work\n");
    git(innerCheckoutPath, "add", "inner-work.txt");
    git(innerCheckoutPath, "commit", "-q", "-m", "inner work");
    const innerTaskCommitOid = git(innerCheckoutPath, "rev-parse", "HEAD").trim();

    // Gitlink bump is its own commit, after the child commit it records (ordering matters, see helper above).
    git(vendorCheckoutPath, "add", "inner");
    git(vendorCheckoutPath, "commit", "-q", "-m", "bump inner gitlink");
    writeFileSync(join(vendorCheckoutPath, "vendor-work.txt"), "vendor work\n");
    git(vendorCheckoutPath, "add", "vendor-work.txt");
    git(vendorCheckoutPath, "commit", "-q", "-m", "vendor work");
    const vendorTaskCommitOid = git(vendorCheckoutPath, "rev-parse", "HEAD").trim();

    git(rootPath, "add", "vendor");
    git(rootPath, "commit", "-q", "-m", "bump vendor gitlink");
    writeFileSync(join(rootPath, "root-work.txt"), "root work\n");
    git(rootPath, "add", "root-work.txt");
    git(rootPath, "commit", "-q", "-m", "root work");

    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            version: REPOSITORY_MANIFEST_VERSION,
            occurrences: [
                makeOccurrence(ROOT_OCCURRENCE_ID, null, rootSourceBranch, rootBaseOid, "task-1", rootPath),
                makeOccurrence("vendor", ROOT_OCCURRENCE_ID, vendorSourceBranch, vendorBaseOid, "task-1", vendorOrigin),
                makeOccurrence("vendor/inner", "vendor", innerSourceBranch, innerBaseOid, "task-1", innerOrigin),
            ],
        },
        resolutionManifest: emptyResolutionManifest(),
    };

    const invocationOrder: string[] = [];
    const reachabilityAtVendorEntry = { checked: false, reachable: false };
    const reachabilityAtRootEntry = { checked: false, reachable: false };
    const gitlinkAtVendorEntry = { recorded: "", childSourceTip: "" };
    const gitlinkAtRootEntry = { recorded: "", childSourceTip: "" };

    const wrappedMergeSubmodule: MergeStepOperations["mergeSubmodule"] = (mainSubmodulePath, worktreeSubmodulePath, sourceBranch) => {
        const isInner = mainSubmodulePath === innerOrigin;
        invocationOrder.push(isInner ? "inner" : "vendor");
        if (!isInner) {
            reachabilityAtVendorEntry.checked = true;
            try {
                git(innerOrigin, "merge-base", "--is-ancestor", innerTaskCommitOid, innerSourceBranch);
                reachabilityAtVendorEntry.reachable = true;
            } catch {
                reachabilityAtVendorEntry.reachable = false;
            }
            // Vendor's task branch must already record inner's post-merge source tip.
            gitlinkAtVendorEntry.recorded = git(vendorCheckoutPath, "rev-parse", "HEAD:inner").trim();
            gitlinkAtVendorEntry.childSourceTip = git(innerOrigin, "rev-parse", innerSourceBranch).trim();
        }
        return mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    };
    const wrappedMergeGroup: MergeStepOperations["mergeGroup"] = (repoRoot, group, sourceBranch, submodulePaths) => {
        invocationOrder.push("root");
        reachabilityAtRootEntry.checked = true;
        try {
            git(vendorOrigin, "merge-base", "--is-ancestor", vendorTaskCommitOid, vendorSourceBranch);
            reachabilityAtRootEntry.reachable = true;
        } catch {
            reachabilityAtRootEntry.reachable = false;
        }
        // Root's task branch must already record vendor's post-merge source tip.
        gitlinkAtRootEntry.recorded = git(rootPath, "rev-parse", "HEAD:vendor").trim();
        gitlinkAtRootEntry.childSourceTip = git(vendorOrigin, "rev-parse", vendorSourceBranch).trim();
        return mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, submodulePaths);
    };

    const report = mergeTaskDeepestFirst(rootPath, manifest, {
        mergeSubmodule: wrappedMergeSubmodule,
        mergeGroup: wrappedMergeGroup,
    });

    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId), ["vendor/inner", "vendor", "root"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged", "merged", "merged"]);
    assert.deepEqual(invocationOrder, ["inner", "vendor", "root"]);
    assert.equal(reachabilityAtVendorEntry.checked, true);
    assert.equal(reachabilityAtVendorEntry.reachable, true);
    assert.equal(reachabilityAtRootEntry.checked, true);
    assert.equal(reachabilityAtRootEntry.reachable, true);
    assert.equal(gitlinkAtVendorEntry.recorded, gitlinkAtVendorEntry.childSourceTip);
    assert.notEqual(gitlinkAtVendorEntry.recorded, innerTaskCommitOid);
    assert.equal(gitlinkAtRootEntry.recorded, gitlinkAtRootEntry.childSourceTip);
    assert.notEqual(gitlinkAtRootEntry.recorded, vendorTaskCommitOid);
});

test("test_mergeTaskDeepestFirstLeavesNoDanglingGitlinkAfterEveryTaskBranchIsDeleted", () => {
    const fixture = buildMergePrimitiveFixture();
    const submoduleTaskBranch = currentBranchName(fixture.worktreeSubmodulePath);
    const vendorTaskCommitOid = commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
    assert.equal(report.status, "merged");

    const rootGitlinkOid = git(fixture.rootPath, "ls-tree", fixture.sourceBranch, "vendor").trim().split(/\s+/)[2];
    const submoduleSourceTip = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
    // Parent must record the post-merge source tip M, not the pre-merge task tip T.
    assert.equal(rootGitlinkOid, submoduleSourceTip);
    // T is still reachable from M, so nothing the parent previously pointed at was lost.
    assert.doesNotThrow(() => git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", vendorTaskCommitOid, fixture.submoduleSourceBranch));

    // Merge alone is not close: the fetched submodule task branch must remain recoverable until close succeeds.
    const submoduleBranches = git(fixture.mainSubmodulePath, "branch", "--list", submoduleTaskBranch);
    assert.equal(submoduleBranches.includes(submoduleTaskBranch), true);

    removeWorktreeAndBranch(fixture.rootPath, fixture.group.worktree, fixture.group.branch);

    assert.doesNotThrow(() => git(fixture.rootPath, "rev-parse", fixture.sourceBranch));
    assert.doesNotThrow(() => git(fixture.mainSubmodulePath, "merge-base", "--is-ancestor", rootGitlinkOid, fixture.submoduleSourceBranch));
});

test("test_mergeTaskDeepestFirstLeavesTheSourceCheckoutsIndexAndWorkingTreeAtTheMergedCommit", () => {
    const fixture = buildMergePrimitiveFixture();
    commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
    assert.equal(report.status, "merged");

    const rootMergedOid = git(fixture.rootPath, "rev-parse", fixture.sourceBranch).trim();
    const submoduleMergedOid = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();

    assert.equal(git(fixture.rootPath, "rev-parse", "HEAD").trim(), rootMergedOid);
    assert.equal(git(fixture.rootPath, "write-tree").trim(), git(fixture.rootPath, "rev-parse", `${rootMergedOid}^{tree}`).trim());
    assert.equal(git(fixture.rootPath, "status", "--short").trim(), "");

    assert.equal(git(fixture.mainSubmodulePath, "rev-parse", "HEAD").trim(), submoduleMergedOid);
    assert.equal(git(fixture.mainSubmodulePath, "write-tree").trim(), git(fixture.mainSubmodulePath, "rev-parse", `${submoduleMergedOid}^{tree}`).trim());
    assert.equal(git(fixture.mainSubmodulePath, "status", "--short").trim(), "");
});

test("test_mergeTaskDeepestFirstSkipsAnOccurrenceAlreadyMergedIntoItsSourceWithoutInvokingItsRebaseOrMergeStep", () => {
    const fixture = buildMergePrimitiveFixture();
    commitSubmoduleWorkAndBumpParentGitlink(fixture);
    writeFileSync(join(fixture.group.worktree, "new.txt"), "brand new\n");
    git(fixture.group.worktree, "add", "new.txt");
    git(fixture.group.worktree, "commit", "-q", "-m", "add new.txt");

    // Simulate a previous lap that already merged the submodule before a later layer failed.
    const preMergeResult = mergeSubmoduleBranchIntoRepo(fixture.mainSubmodulePath, fixture.worktreeSubmodulePath, fixture.submoduleSourceBranch);
    assert.equal(preMergeResult.merged, true);
    const submoduleOidAfterPreMerge = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();

    let submoduleMergeCalled = false;
    const refusingMergeSubmodule: MergeStepOperations["mergeSubmodule"] = () => {
        submoduleMergeCalled = true;
        return { merged: false, conflictedFilePaths: [], failureReason: "should not be called" };
    };

    const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest, {
        mergeSubmodule: refusingMergeSubmodule,
        mergeGroup: mergeGroupBranchIntoRepo,
    });

    assert.equal(submoduleMergeCalled, false);
    // Propagation checks out the already-merged tip; a rebase attempt would have produced a different commit.
    assert.equal(git(fixture.worktreeSubmodulePath, "rev-parse", "HEAD").trim(), submoduleOidAfterPreMerge);
    assert.equal(report.status, "merged");
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["no-op", "merged"]);
    const skippedLayer = report.completedLayers[0];
    assert.equal(skippedLayer.status, "no-op");
    if (skippedLayer.status === "no-op") assert.equal(skippedLayer.oid, submoduleOidAfterPreMerge);
});

test("test_mergeTaskDeepestFirstLeavesAnAlreadyMergedSubmoduleInPlaceWhenTheParentThenConflicts", () => {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    addPassingTestScriptToSubmoduleOrigin(mainSubmodulePath);
    git(rootPath, "add", "vendor");
    git(rootPath, "commit", "-q", "-m", "bump vendor gitlink for test script");
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    writeFileSync(join(rootPath, "shared.txt"), "line1\n");
    git(rootPath, "add", "shared.txt");
    git(rootPath, "commit", "-q", "-m", "add shared.txt");
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    const discoveryManifest: DiscoveryManifest = { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() };

    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");
    git(group.worktree, "add", "vendor");
    git(group.worktree, "commit", "-q", "-m", "bump vendor gitlink");

    writeFileSync(join(rootPath, "shared.txt"), "line1-from-main\n");
    git(rootPath, "add", "shared.txt");
    git(rootPath, "commit", "-q", "-m", "main edit");

    const report = mergeTaskDeepestFirst(group.worktree, discoveryManifest);

    assert.equal(report.status, "parent-conflicted");
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["merged"]);

    const submoduleLayer = report.completedLayers[0];
    const submoduleOidAfterMerge = submoduleLayer.status === "merged" ? submoduleLayer.oid : null;
    assert.equal(git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim(), submoduleOidAfterMerge);
});

test("retry propagates a later child source tip while retaining the task historical child merge oid", () => {
    const fixture = buildMergePrimitiveFixture();
    const branch = fixture.group.branch;
    // mergeTaskDeepestFirst rewrites occurrence.checkoutPath in place; each call needs its own copy.
    const originalOccurrences = fixture.discoveryManifest.repositoryManifest.occurrences.map((o) => ({ ...o }));
    const freshManifest = (): DiscoveryManifest => ({
        repositoryManifest: { ...fixture.discoveryManifest.repositoryManifest, occurrences: originalOccurrences.map((o) => ({ ...o })) },
        resolutionManifest: emptyResolutionManifest(),
    });

    // Task A changes the child and records that gitlink in its parent branch.
    commitSubmoduleWorkAndBumpParentGitlink(fixture);

    let failParentOnce = true;
    const first = mergeTaskDeepestFirst(fixture.group.worktree, freshManifest(), {
        ...defaultMergeStepOperations,
        mergeGroup: (repoRoot, group, sourceBranch, submodulePaths) => {
            if (failParentOnce) {
                failParentOnce = false;
                return {
                    groupId: group.groupId,
                    merged: false,
                    conflictedFilePaths: ["parent.txt"],
                    submoduleConflicts: [],
                    worktree: group.worktree,
                    failureReason: "forced parent failure after child merge",
                };
            }
            return defaultMergeStepOperations.mergeGroup(repoRoot, group, sourceBranch, submodulePaths);
        },
    });

    assert.equal(first.status, "parent-conflicted");
    const firstChild = first.completedLayers.find((layer) => layer.occurrenceId === "vendor")!;
    assert.equal(firstChild.status, "merged");
    const taskAChildMergeOid = firstChild.status === "merged" ? firstChild.mergedCommitOid : null;

    // Task B advances the canonical child source after A's child already merged.
    writeFileSync(join(fixture.mainSubmodulePath, "task-b.txt"), "B\n");
    git(fixture.mainSubmodulePath, "add", "task-b.txt");
    git(fixture.mainSubmodulePath, "commit", "-q", "-m", "task B advances child");
    const taskBChildTip = git(fixture.mainSubmodulePath, "rev-parse", fixture.submoduleSourceBranch).trim();
    assert.notEqual(taskBChildTip, taskAChildMergeOid);

    const retried = mergeTaskDeepestFirst(fixture.group.worktree, freshManifest());
    assert.equal(retried.status, "merged");
    if (retried.status !== "merged") return assert.fail("expected retry to merge");

    const retriedChild = retried.completedLayers.find((layer) => layer.occurrenceId === "vendor")!;
    assert.equal(retriedChild.status, "no-op");
    if (retriedChild.status !== "no-op") return assert.fail("expected the child to be a no-op on retry");
    assert.equal(retriedChild.oid, taskBChildTip);
    assert.equal(retriedChild.mergedCommitOid, taskAChildMergeOid);

    // Parent records B's current child tip; A's historical merge attribution stays unchanged.
    assert.equal(git(fixture.rootPath, "rev-parse", `${fixture.sourceBranch}:vendor`).trim(), taskBChildTip);
    assert.equal(
        git(fixture.mainSubmodulePath, "rev-parse", `refs/taskTools/merged-commits/${branch}`).trim(),
        taskAChildMergeOid,
    );
});

test("test_mergeTaskDeepestFirstStopsAtASubmoduleConflictWithoutAttemptingTheParentMerge", () => {
    const rootPath = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(rootPath, "vendor");
    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const rootBaseOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const submoduleBaseOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence(ROOT_OCCURRENCE_ID, null, sourceBranch, rootBaseOid, group.branch, rootPath),
            makeOccurrence("vendor", ROOT_OCCURRENCE_ID, submoduleSourceBranch, submoduleBaseOid, group.branch, mainSubmodulePath),
        ],
    };
    const discoveryManifest: DiscoveryManifest = { repositoryManifest: manifest, resolutionManifest: emptyResolutionManifest() };

    writeFileSync(join(worktreeSubmodulePath, "seed.txt"), "from-worktree\n");
    git(worktreeSubmodulePath, "add", "seed.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(mainSubmodulePath, "seed.txt"), "from-main\n");
    git(mainSubmodulePath, "add", "seed.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "main edit");

    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    let parentMergeCalled = false;
    const refusingMergeGroup: MergeStepOperations["mergeGroup"] = () => {
        parentMergeCalled = true;
        return { groupId: 0, merged: false, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree, failureReason: "should not be called" };
    };

    const report = mergeTaskDeepestFirst(group.worktree, discoveryManifest, {
        mergeSubmodule: mergeSubmoduleBranchIntoRepo,
        mergeGroup: refusingMergeGroup,
    });

    assert.equal(parentMergeCalled, false);
    assert.equal(report.status, "submodule-conflicted");
    assert.deepEqual(report.completedLayers, []);
});

test("test_listTaskWorktreesRecognizesATaskNWorktreeCreatedByThePreparer", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);

    const worktrees = listTaskWorktrees(repoRoot);

    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].branch, group.branch);
    assert.equal(basename(worktrees[0].path), basename(group.worktree));
});
