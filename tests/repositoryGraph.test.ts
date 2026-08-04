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
