// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    rebaseGroupOntoSource,
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
        ["merged", "conflicts", "testReceipts", "reviewHandoffs", "occurrenceDigests", "runState", "publicationTargets", "abortReason"].sort(),
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
    const group = makeGroup(rootPath, 1);
    group.tasks = [{ number: taskNumber, briefFile: "", planFile: "", files: [] }];
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
        JSON.stringify([{ taskNumber, title: "t", description: "d", files: [], difficulty: 1, blockedBy: [] }]) + "\n",
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

function runPipelineCli(cliInput: unknown): { publicationTargets: unknown[] } {
    return JSON.parse(execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" }));
}

function readTaskNumbers(taskToolsDir: string, fileName: string): number[] {
    return JSON.parse(readFileSync(join(taskToolsDir, fileName), "utf8")).map((task: { taskNumber: number }) => task.taskNumber);
}

test("test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives", () => {
    // Another writer moves the base ref after the manifest is captured, so publication must refuse.
    const raced = buildNestedFixtureWithTask(9101);
    writeFileSync(join(raced.rootPath, "raced.txt"), "another writer\n");
    git(raced.rootPath, "add", "raced.txt");
    git(raced.rootPath, "commit", "-q", "-m", "someone else moved the base");

    assert.deepEqual(runPipelineCli(raced.cliInput).publicationTargets, []);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "tasks.json"), [9101]);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "completedTasks.json"), []);
    for (const path of raced.runFiles) assert.equal(existsSync(path), true);

    // Nothing races the base ref, so the task is archived and the run inputs are cleaned up.
    const clean = buildNestedFixtureWithTask(9102);
    assert.notDeepEqual(runPipelineCli(clean.cliInput).publicationTargets, []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "tasks.json"), []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "completedTasks.json"), [9102]);
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
