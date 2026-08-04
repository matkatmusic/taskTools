// Behavioral checks for ownershipKeys.ts: canonical key derivation and effect expansion.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeCanonicalOwnershipKey,
    expandTaskPathEffects,
} from "../scripts/ownershipKeys.ts";
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
        originUrl: "https://example.com/group/jfred.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

const JFRED_URL = "https://example.com/group/jfred.git";
const TMUX_LIB_URL = "https://example.com/group/tmux_lib.git";
const JFRED_TOOLS_URL = "https://example.com/group/jfredToolsPlugin.git";
const ONLY_ONE_LIB_URL = "https://example.com/group/only_one_lib.git";

// jfred (JFRED_URL) jfred/external/tmux_lib (TMUX_LIB_URL) jfred/jfredToolsPlugin (JFRED_TOOLS_URL) jfred/jfredToolsPlugin/external/tmux_lib (TMUX_LIB_URL) tmux_lib (TMUX_LIB_URL, standalone root) only_one_lib (ONLY_ONE_LIB_URL, standalone root)
const jfred = makeOccurrence({
    occurrenceId: "jfred",
    checkoutPath: "jfred",
    originUrl: JFRED_URL,
    childOccurrenceIds: ["externalTmuxLib", "jfredToolsPlugin"],
});
const externalTmuxLib = makeOccurrence({
    occurrenceId: "externalTmuxLib",
    checkoutPath: "jfred/external/tmux_lib",
    parentOccurrenceId: "jfred",
    pathInParent: "external/tmux_lib",
    depth: 1,
    originUrl: TMUX_LIB_URL,
});
const jfredToolsPlugin = makeOccurrence({
    occurrenceId: "jfredToolsPlugin",
    checkoutPath: "jfred/jfredToolsPlugin",
    parentOccurrenceId: "jfred",
    pathInParent: "jfredToolsPlugin",
    depth: 1,
    originUrl: JFRED_TOOLS_URL,
    childOccurrenceIds: ["jfredToolsPluginTmuxLib"],
});
const jfredToolsPluginTmuxLib = makeOccurrence({
    occurrenceId: "jfredToolsPluginTmuxLib",
    checkoutPath: "jfred/jfredToolsPlugin/external/tmux_lib",
    parentOccurrenceId: "jfredToolsPlugin",
    pathInParent: "external/tmux_lib",
    depth: 2,
    originUrl: TMUX_LIB_URL,
});
const tmuxLibTopLevel = makeOccurrence({
    occurrenceId: "tmux1",
    checkoutPath: "tmux_lib",
    originUrl: TMUX_LIB_URL,
});
const onlyOneLib = makeOccurrence({
    occurrenceId: "only1",
    checkoutPath: "only_one_lib",
    originUrl: ONLY_ONE_LIB_URL,
});

const manifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [jfred, externalTmuxLib, jfredToolsPlugin, jfredToolsPluginTmuxLib, tmuxLibTopLevel, onlyOneLib],
};

test("test_twoAliasPathsForSameLogicalFileProduceSameCanonicalKey", () => {
    // Two occurrence paths naming the same file inside the same logical tmux_lib repo.
    const pathA = "jfred/external/tmux_lib/src/foo.ts";
    const pathB = "jfred/jfredToolsPlugin/external/tmux_lib/src/foo.ts";

    const keyA = computeCanonicalOwnershipKey(pathA, manifest);
    const keyB = computeCanonicalOwnershipKey(pathB, manifest);

    assert.deepEqual(keyA, keyB);
});

test("test_pathInsideTmuxLibOccurrenceExpandsToAllThreeOccurrencePaths", () => {
    // A path inside one tmux_lib occurrence expands to all three known tmux_lib occurrence paths.
    const effects = expandTaskPathEffects("jfred/external/tmux_lib/src/foo.ts", manifest);

    assert.deepEqual(
        new Set(effects.occurrencePaths),
        new Set([
            "jfred/external/tmux_lib/src/foo.ts",
            "jfred/jfredToolsPlugin/external/tmux_lib/src/foo.ts",
            "tmux_lib/src/foo.ts",
        ]),
    );
    assert.equal(effects.occurrencePaths.length, 3);
});

test("test_expansionIncludesEachDistinctAncestorGitlinkToRoot", () => {
    // tmux_lib occurrences sit under different parent chains: jfred, jfred/jfredToolsPlugin, and none.
    const effects = expandTaskPathEffects("jfred/external/tmux_lib/src/foo.ts", manifest);

    assert.deepEqual(new Set(effects.ancestorGitlinks), new Set(["jfred", "jfred/jfredToolsPlugin"]));
    assert.equal(effects.ancestorGitlinks.length, 2);
});

test("test_pathInUniqueRepositoryExpandsToItselfPlusAncestorGitlinks", () => {
    // only_one_lib has exactly one occurrence and no parent chain.
    const taskPath = "only_one_lib/file.txt";
    const effects = expandTaskPathEffects(taskPath, manifest);

    assert.deepEqual(effects.occurrencePaths, [taskPath]);
    assert.deepEqual(effects.ancestorGitlinks, []);
});

test("test_pathsInDifferentLogicalRepositoriesNeverShareAKey", () => {
    // "jfred/somefile.ts" belongs to the jfred repo; "only_one_lib/other.ts" belongs to only_one_lib.
    const keyJfred = computeCanonicalOwnershipKey("jfred/somefile.ts", manifest);
    const keyOnlyOneLib = computeCanonicalOwnershipKey("only_one_lib/other.ts", manifest);

    assert.notDeepEqual(keyJfred, keyOnlyOneLib);
    assert.notEqual(keyJfred.canonicalOccurrenceId, keyOnlyOneLib.canonicalOccurrenceId);
});
