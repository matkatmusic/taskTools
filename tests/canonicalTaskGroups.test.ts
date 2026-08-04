// Behavioral checks for canonicalTaskGroups.ts: grouping tasks by canonical ownership key overlap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalTaskGroups } from "../scripts/canonicalTaskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function task(taskNumber: number, files?: string[]): TaskRecord {
    return files === undefined ? { taskNumber } : { taskNumber, files };
}

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

// jfred (JFRED_URL) jfred/external/tmux_lib (TMUX_LIB_URL) jfred/jfredToolsPlugin (JFRED_TOOLS_URL) jfred/jfredToolsPlugin/external/tmux_lib (TMUX_LIB_URL, same logical repo)
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

const manifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [jfred, externalTmuxLib, jfredToolsPlugin, jfredToolsPluginTmuxLib],
};

test("test_sameLogicalFileViaDifferentOccurrencePathsLandsInOneGroup", () => {
    const tasks = [
        task(1, ["jfred/external/tmux_lib/src/foo.ts"]),
        task(2, ["jfred/jfredToolsPlugin/external/tmux_lib/src/foo.ts"]),
    ];
    const groups = buildCanonicalTaskGroups(tasks, manifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_disjointFilesInSameOwnershipRootStaySeparate", () => {
    const tasks = [task(1, ["jfred/somefileA.ts"]), task(2, ["jfred/somefileB.ts"])];
    const groups = buildCanonicalTaskGroups(tasks, manifest);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.taskNumbers), [[1], [2]]);
});

test("test_overlapOnlyViaAncestorGitlinkEffectsStillUnions", () => {
    // Primary keys differ, but both tasks share the "jfred" ancestor-gitlink effect key.
    const tasks = [
        task(1, ["jfred/external/tmux_lib/src/foo.ts"]),
        task(2, ["jfred/jfredToolsPlugin/src/bar.ts"]),
    ];
    const groups = buildCanonicalTaskGroups(tasks, manifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_buildCanonicalTaskGroupsIsDeterministicRegardlessOfInputOrder", () => {
    const tasks = [
        task(1, ["jfred/external/tmux_lib/src/foo.ts"]),
        task(2, ["jfred/jfredToolsPlugin/external/tmux_lib/src/foo.ts"]),
        task(3, ["jfred/somefileA.ts"]),
        task(4, ["jfred/jfredToolsPlugin/src/bar.ts"]),
        task(5),
    ];

    const first = buildCanonicalTaskGroups(tasks, manifest);
    const second = buildCanonicalTaskGroups(tasks, manifest);
    const reversed = buildCanonicalTaskGroups([...tasks].reverse(), manifest);

    assert.deepEqual(first, second);
    assert.deepEqual(first, reversed);
});
