# Task 44: Separate repositoryDiscovery read-only query from its branch-creating side effect

Today scripts/repositoryDiscovery.ts discoverRepositoryTree unconditionally calls setUpOperationBranches on its resolved path (lines 148-152), and scripts/operationBranches.ts line 71 runs a real git checkout against occurrence.checkoutPath. Discovery also mints its own runId with randomUUID at line 147. That makes discoverRepositoryTree a run-initiating mutation rather than a query, so any read-only caller silently gets its working directory checked out onto a tackle-op branch.

Make discoverRepositoryTree read-only: it returns the graph and resolution status without creating or checking out any branch. Callers that want operation branches call setUpOperationBranches explicitly, passing the runId in rather than having discovery generate one.

This blocks task 35, whose step 1 swaps collectRepositorySources onto graph discovery and is called against the production repo root before any worktree exists — a naive swap would check the user real working directory out onto a throwaway branch.

Tests: discoverRepositoryTree creates no branch and performs no checkout on the resolved path; the working directory branch is unchanged after discovery; setUpOperationBranches still creates and checks out branches when called directly; the runId used for operation branch names is the one the caller passed in; existing repositoryDiscovery and operationBranches suites keep passing.

### scripts/repositoryDiscovery.ts

```
// Root-outward discovery of a repository's nested submodule tree, gated on full branch resolution.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { setUpOperationBranches } from "./operationBranches.ts";

export type DiscoveryManifest = {
    repositoryManifest: RepositoryManifest;
    resolutionManifest: ResolutionManifest;
};

export type DiscoveryResult =
    | { status: "resolved"; graph: RepositoryOccurrence[] }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };

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
        originUrl: existing?.originUrl ?? "",
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

    const runId = randomUUID();
    for (const occurrence of manifest.repositoryManifest.occurrences) {
        if (occurrence.operationBranch !== "") continue;
        const [updated] = setUpOperationBranches([occurrence], runId);
        occurrence.operationBranch = updated.operationBranch;
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

```

### tests/operationBranches.test.ts

```
// Behavioral checks for operationBranches.ts: branch-at-recorded-oid, idempotency, conflict, and abort-on-unready.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import {
    OperationBranchConflictError,
    OperationBranchSetupError,
    operationBranchName,
    setUpOperationBranches,
} from "../scripts/operationBranches.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "operation-branches-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    return repoPath;
}

function commit(repoPath: string, fileName: string): string {
    writeFileSync(join(repoPath, fileName), `${fileName}\n`);
    git(repoPath, "add", fileName);
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/root.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

function assertNoWorktreeDirectoryCreated(occurrence: RepositoryOccurrence): void {
    const workerWorktreePath = join(tmpdir(), "worktrees", occurrence.occurrenceId);
    assert.equal(existsSync(workerWorktreePath), false);
}

test("test_branchCreatedAtRecordedOidEvenWhenCheckoutIsElsewhere", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });

    const [result] = setUpOperationBranches([occurrence], "run1");
    const branchName = operationBranchName("run1", occurrence);

    assert.equal(git(repoPath, "rev-parse", branchName), oidA);
    assert.equal(git(repoPath, "branch", "--show-current"), branchName);
    assert.equal(result.operationBranch, branchName);
});

test("test_reRunningIsANoOp", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });

    setUpOperationBranches([occurrence], "run1");
    const branchName = operationBranchName("run1", occurrence);
    const oidAfterFirstRun = git(repoPath, "rev-parse", branchName);
    const branchesAfterFirstRun = git(repoPath, "branch", "--list");

    assert.doesNotThrow(() => setUpOperationBranches([occurrence], "run1"));
    assert.equal(git(repoPath, "rev-parse", branchName), oidAfterFirstRun);
    assert.equal(git(repoPath, "branch", "--list"), branchesAfterFirstRun);
});

test("test_existingBranchAtDifferentOidErrors", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    const oidB = commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });
    const branchName = operationBranchName("run1", occurrence);
    git(repoPath, "branch", branchName, oidB);

    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchConflictError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.match((error as Error).message, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.match((error as Error).message, new RegExp(oidA));
            assert.match((error as Error).message, new RegExp(oidB));
            return true;
        },
    );
    assert.equal(git(repoPath, "rev-parse", branchName), oidB);
    assertNoWorktreeDirectoryCreated(occurrence);
});

test("test_detachedHeadOccurrenceAbortsSetupAndNamesIt", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    git(repoPath, "checkout", "-q", oidA);
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });
    const branchName = operationBranchName("run1", occurrence);

    assertNoWorktreeDirectoryCreated(occurrence);
    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchSetupError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        },
    );
    assert.throws(() => git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`));
    assertNoWorktreeDirectoryCreated(occurrence);
});

test("test_occurrenceWithNoResolvedBaseBranchAbortsSetup", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "" });
    const branchName = operationBranchName("run1", occurrence);

    assertNoWorktreeDirectoryCreated(occurrence);
    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchSetupError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        },
    );
    assert.throws(() => git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`));
    assertNoWorktreeDirectoryCreated(occurrence);
});

```
