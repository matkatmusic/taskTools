# Task 52: End-to-end integration test: prepareTasks against a real repository

Phase 1 to 3 was unit-tested entirely against hand-written manifest fixtures and never executed against a real repository, so wiring it into production (task 48) broke tackle-tasks completely and was reverted in commit fbe32a7. Three integration defects were found and none were caught by the 1027-test suite.

1. scripts/repositoryDiscovery.ts line 72 records checkoutPath as an absolute path via join(rootPath, relativePath), while scripts/repositoryGraph.ts isWithinCheckout matches it against root-relative task paths like scripts/foo.ts — so nothing owns any path and prepareTasks throws: no occurrence owns path scripts/mergeTaskWorktrees.ts. Decision already made by the user: absolute wins, and the graph matchers relativize against the root occurrence checkoutPath. Do not re-litigate that.

2. scripts/repositoryDiscovery.ts line 103 sets originUrl to existing?.originUrl ?? empty string and never reads the git remote, but logical repository identity is keyed on originUrl, so ownership fails with: occurrence has an unparseable origin URL.

3. The root occurrence is given an empty occurrenceId.

Also reconcile the coordinate systems: tests/repositoryGraph.test.ts uses a fixture whose task paths are relative to the root occurrence PARENT directory (root checkoutPath jfred, paths like jfred/external/tmux_lib/src/foo.ts), while production task paths are relative to the repo root itself. Those two conventions conflict and one of them has to give.

Add tests/prepareTasksIntegration.test.ts that builds a real temporary git repository with an origin remote and at least one submodule, then runs bootstrapRepositoryManifest, groupTasksByFileOverlap and buildWorkflowArguments against it and asserts: ownership resolves for a root file path and for a submodule file path; every occurrence carries a non-empty originUrl and occurrenceId; grouping returns real groups instead of throwing.

Fix scripts/repositoryDiscovery.ts and scripts/repositoryGraph.ts as needed to make it pass. This must land before task 48 is re-attempted.

### tests/prepareTasksIntegration.test.ts

(missing: file not found on disk)

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

    return { status: "resolved", graph: manifest.repositoryManifest.occurrences };
}

```

### scripts/repositoryGraph.ts

```
// Pure traversal helpers over the occurrence graph recorded by repositoryManifest.ts.
import { relative } from "node:path";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";

function findRootOccurrence(manifest: RepositoryManifest): RepositoryOccurrence | null {
    return manifest.occurrences.find((occurrence) => occurrence.parentOccurrenceId === null) ?? null;
}

// Discovery records checkoutPath absolutely; task paths are root-relative. relative() collapses both.
function checkoutPathFromRoot(occurrence: RepositoryOccurrence, root: RepositoryOccurrence): string {
    return relative(root.checkoutPath, occurrence.checkoutPath);
}

function buildOccurrenceIndex(manifest: RepositoryManifest): Map<string, RepositoryOccurrence> {
    return new Map(manifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
}

export function getChildren(
    occurrence: RepositoryOccurrence,
    manifest: RepositoryManifest,
): RepositoryOccurrence[] {
    const index = buildOccurrenceIndex(manifest);
    return occurrence.childOccurrenceIds.map((childId) => {
        const child = index.get(childId);
        if (!child) throw new Error(`missing occurrence for child ID "${childId}"`);
        return child;
    });
}

// Walks recorded parentOccurrenceId edges up to the root; excludes the occurrence itself.
export function getAncestorChain(
    occurrence: RepositoryOccurrence,
    manifest: RepositoryManifest,
): RepositoryOccurrence[] {
    const index = buildOccurrenceIndex(manifest);
    const chain: RepositoryOccurrence[] = [];
    let current = occurrence;
    while (current.parentOccurrenceId !== null) {
        const parent = index.get(current.parentOccurrenceId);
        if (!parent) break;
        chain.push(parent);
        current = parent;
    }
    return chain;
}

export function getDeepestFirstOrder(occurrences: RepositoryOccurrence[]): RepositoryOccurrence[] {
    return [...occurrences].sort((a, b) => {
        if (a.depth !== b.depth) return b.depth - a.depth;
        return (a.pathInParent ?? "").localeCompare(b.pathInParent ?? "");
    });
}

function isWithinCheckout(rootRelativePath: string, checkoutPath: string): boolean {
    if (checkoutPath === "") return true;
    return rootRelativePath === checkoutPath || rootRelativePath.startsWith(`${checkoutPath}/`);
}

// Descends recorded child edges, matching only recorded checkoutPath -- never splits the input path.
export function getOwningOccurrence(
    rootRelativePath: string,
    manifest: RepositoryManifest,
): RepositoryOccurrence | null {
    let owner =
        manifest.occurrences.find(
            (occurrence) =>
                occurrence.parentOccurrenceId === null &&
                isWithinCheckout(rootRelativePath, occurrence.checkoutPath),
        ) ?? null;
    if (!owner) return null;

    let descended = true;
    while (descended) {
        descended = false;
        for (const child of getChildren(owner, manifest)) {
            if (isWithinCheckout(rootRelativePath, child.checkoutPath)) {
                owner = child;
                descended = true;
                break;
            }
        }
    }
    return owner;
}

export function getPathWithinRepository(
    rootRelativePath: string,
    owningOccurrence: RepositoryOccurrence,
): string {
    const { checkoutPath } = owningOccurrence;
    if (checkoutPath === "") return rootRelativePath;
    if (rootRelativePath === checkoutPath) return "";
    return rootRelativePath.slice(checkoutPath.length + 1);
}

```

### tests/repositoryGraph.test.ts

```
// Behavioral checks for repositoryGraph.ts: edge-driven traversal over a fixture graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    getChildren,
    getAncestorChain,
    getDeepestFirstOrder,
    getOwningOccurrence,
    getPathWithinRepository,
} from "../scripts/repositoryGraph.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "jfred",
        checkoutPath: "jfred",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/jfred.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

function buildFixture(insertionOrder: RepositoryOccurrence[]): RepositoryManifest {
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: insertionOrder };
}

// jfred jfred/external/tmux_lib          (parent: jfred) jfred/jfredToolsPlugin           (parent: jfred) jfred/jfredToolsPlugin/external/tmux_lib  (parent: jfredToolsPlugin)
const jfred = makeOccurrence({
    occurrenceId: "jfred",
    checkoutPath: "jfred",
    childOccurrenceIds: ["externalTmuxLib", "jfredToolsPlugin"],
});
const externalTmuxLib = makeOccurrence({
    occurrenceId: "externalTmuxLib",
    checkoutPath: "jfred/external/tmux_lib",
    parentOccurrenceId: "jfred",
    pathInParent: "external/tmux_lib",
    depth: 1,
});
const jfredToolsPlugin = makeOccurrence({
    occurrenceId: "jfredToolsPlugin",
    checkoutPath: "jfred/jfredToolsPlugin",
    parentOccurrenceId: "jfred",
    pathInParent: "jfredToolsPlugin",
    depth: 1,
    childOccurrenceIds: ["jfredToolsPluginTmuxLib"],
});
const jfredToolsPluginTmuxLib = makeOccurrence({
    occurrenceId: "jfredToolsPluginTmuxLib",
    checkoutPath: "jfred/jfredToolsPlugin/external/tmux_lib",
    parentOccurrenceId: "jfredToolsPlugin",
    pathInParent: "external/tmux_lib",
    depth: 2,
});

const manifest = buildFixture([jfred, externalTmuxLib, jfredToolsPlugin, jfredToolsPluginTmuxLib]);

test("test_getChildrenReturnsOnlyDirectChildrenNotGrandchildren", () => {
    const children = getChildren(jfred, manifest);
    assert.deepEqual(
        children.map((c) => c.checkoutPath).sort(),
        ["jfred/external/tmux_lib", "jfred/jfredToolsPlugin"],
    );
    assert.ok(!children.some((c) => c.checkoutPath === "jfred/jfredToolsPlugin/external/tmux_lib"));
});

test("test_getAncestorChainWalksParentEdgesUpToRoot", () => {
    const chain = getAncestorChain(jfredToolsPluginTmuxLib, manifest);
    assert.deepEqual(
        chain.map((o) => o.checkoutPath),
        ["jfred/jfredToolsPlugin", "jfred"],
    );
});

test("test_parentOfNestedRepoIsTheImmediateRepositoryOccurrenceNotASyntheticPathSegment", () => {
    assert.equal(externalTmuxLib.parentOccurrenceId, "jfred");
});

test("test_noTraversalEverYieldsTheSyntheticPathSegmentAsAnOccurrence", () => {
    assert.ok(!manifest.occurrences.some((o) => o.checkoutPath === "jfred/external"));
    const children = getChildren(jfred, manifest);
    assert.ok(!children.some((c) => c.checkoutPath === "jfred/external"));
    const chain = getAncestorChain(jfredToolsPluginTmuxLib, manifest);
    assert.ok(!chain.some((o) => o.checkoutPath === "jfred/external"));
});

test("test_getOwningOccurrenceResolvesToTheDeepestMatchingRepositoryNotItsAncestor", () => {
    const owner = getOwningOccurrence("jfred/external/tmux_lib/src/foo.ts", manifest);
    assert.equal(owner?.checkoutPath, "jfred/external/tmux_lib");
});

test("test_getPathWithinRepositoryIsRelativeToTheOwningOccurrenceRoot", () => {
    const owner = getOwningOccurrence("jfred/external/tmux_lib/src/foo.ts", manifest);
    assert.ok(owner);
    assert.equal(getPathWithinRepository("jfred/external/tmux_lib/src/foo.ts", owner!), "src/foo.ts");
});

test("test_getDeepestFirstOrderSortsByDepthThenByPathWithinParentRegardlessOfInsertionOrder", () => {
    const shuffled = [jfredToolsPlugin, jfredToolsPluginTmuxLib, jfred, externalTmuxLib];
    const ordered = getDeepestFirstOrder(shuffled);
    assert.deepEqual(
        ordered.map((o) => o.checkoutPath),
        [
            "jfred/jfredToolsPlugin/external/tmux_lib",
            "jfred/external/tmux_lib",
            "jfred/jfredToolsPlugin",
            "jfred",
        ],
    );

    const shuffledAgain = [externalTmuxLib, jfred, jfredToolsPluginTmuxLib, jfredToolsPlugin];
    const orderedAgain = getDeepestFirstOrder(shuffledAgain);
    assert.deepEqual(
        orderedAgain.map((o) => o.checkoutPath),
        ordered.map((o) => o.checkoutPath),
    );
});

```
