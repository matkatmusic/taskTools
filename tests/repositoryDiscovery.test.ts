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
    for (const occurrence of result.graph) {
        assert.notEqual(occurrence.operationBranch, "");
    }

    const innerSubmodule = findOccurrence(result.graph, "jfred/jfredToolsPlugin/innerSubmodule");
    const ancestorIds = getAncestorChain(innerSubmodule, manifest.repositoryManifest).map(
        (occurrence) => occurrence.occurrenceId,
    );
    assert.deepEqual(ancestorIds, ["jfred/jfredToolsPlugin", "jfred", ""]);
});
