// Behavioral checks for relatedTests.ts: per-occurrence batching of edited files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupEditsByOccurrence } from "../scripts/relatedTests.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "repo",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/repo.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

const rootPath = "/workspace";

const root = makeOccurrence({ occurrenceId: "root", checkoutPath: "repo", childOccurrenceIds: ["pluginRepo"] });
const pluginRepo = makeOccurrence({
    occurrenceId: "pluginRepo",
    checkoutPath: "repo/plugin",
    parentOccurrenceId: "root",
    pathInParent: "plugin",
    depth: 1,
    childOccurrenceIds: ["nestedLib"],
});
const nestedLib = makeOccurrence({
    occurrenceId: "nestedLib",
    checkoutPath: "repo/plugin/vendor/lib",
    parentOccurrenceId: "pluginRepo",
    pathInParent: "vendor/lib",
    depth: 2,
});

const manifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [root, pluginRepo, nestedLib],
};

const rootFile = "/workspace/repo/src/app.test.ts";
const pluginFile = "/workspace/repo/plugin/src/thing.test.ts";
const nestedFile = "/workspace/repo/plugin/vendor/lib/src/foo.test.ts";

test("test_fileInsideNestedOccurrenceResolvesToItNotItsAncestorOrTheRoot", () => {
    const { batches } = groupEditsByOccurrence([nestedFile], rootPath, manifest);
    assert.deepEqual([...batches.keys()], ["nestedLib"]);
});

test("test_editsSpanningTwoOccurrencesYieldTwoBatchesEachHoldingOnlyItsOwnFiles", () => {
    const { batches } = groupEditsByOccurrence([pluginFile, nestedFile], rootPath, manifest);
    assert.equal(batches.size, 2);
    const pluginSources = [...batches.get("pluginRepo")!.byExtension.values()].flatMap((b) => b.sources);
    const nestedSources = [...batches.get("nestedLib")!.byExtension.values()].flatMap((b) => b.sources);
    assert.deepEqual(pluginSources, [pluginFile]);
    assert.deepEqual(nestedSources, [nestedFile]);
});

test("test_fileDirectlyInRootRepoMapsToTheRootOccurrence", () => {
    const { batches } = groupEditsByOccurrence([rootFile], rootPath, manifest);
    assert.deepEqual([...batches.keys()], ["root"]);
});
