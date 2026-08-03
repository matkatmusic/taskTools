// Behavioral checks for repositoryManifest.ts: round-trip serialization + graph validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    REPOSITORY_MANIFEST_VERSION,
    readRepositoryManifest,
    writeRepositoryManifest,
    validateRepositoryManifest,
    type RepositoryOccurrence,
    type RepositoryManifest,
} from "../scripts/repositoryManifest.ts";

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
        operationBranch: "task-group-1",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

test("test_roundTripSerializationPreservesEveryOccurrenceField", () => {
    const root = makeOccurrence({
        occurrenceId: "root",
        checkoutPath: "",
        childOccurrenceIds: ["child"],
    });
    const child = makeOccurrence({
        occurrenceId: "child",
        checkoutPath: "child",
        parentOccurrenceId: "root",
        pathInParent: "child",
        gitlinkOid: "1".repeat(40),
        depth: 1,
        childOccurrenceIds: ["grandchild"],
    });
    const grandchild = makeOccurrence({
        occurrenceId: "grandchild",
        checkoutPath: "child/grandchild",
        parentOccurrenceId: "child",
        pathInParent: "grandchild",
        gitlinkOid: "2".repeat(40),
        depth: 2,
        childOccurrenceIds: [],
    });
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [root, child, grandchild],
    };

    const dir = mkdtempSync(join(tmpdir(), "repository-manifest-"));
    const path = join(dir, "manifest.json");
    writeRepositoryManifest(path, manifest);
    const readBack = readRepositoryManifest(path);

    assert.deepEqual(readBack, manifest);
});

test("test_validateRejectsADanglingParentOccurrenceId", () => {
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence({ occurrenceId: "root" }),
            makeOccurrence({
                occurrenceId: "child",
                checkoutPath: "child",
                parentOccurrenceId: "does-not-exist",
                pathInParent: "child",
                depth: 1,
            }),
        ],
    };

    const result = validateRepositoryManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("does-not-exist")));
});

test("test_validateRejectsDuplicateOccurrenceIds", () => {
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence({ occurrenceId: "dup" }),
            makeOccurrence({ occurrenceId: "dup" }),
        ],
    };

    const result = validateRepositoryManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("dup")));
});

test("test_validateRejectsADepthInconsistentWithTheParentChain", () => {
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [
            makeOccurrence({ occurrenceId: "root", depth: 0 }),
            makeOccurrence({
                occurrenceId: "child",
                checkoutPath: "child",
                parentOccurrenceId: "root",
                pathInParent: "child",
                depth: 5,
            }),
        ],
    };

    const result = validateRepositoryManifest(manifest);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("depth")));
});

test("test_validateAcceptsANestedManifestWhoseParentIsTheImmediateRepositoryOccurrenceNotASyntheticPathSegment", () => {
    const root = makeOccurrence({ occurrenceId: "root", checkoutPath: "", depth: 0 });
    const jfred = makeOccurrence({
        occurrenceId: "jfred",
        checkoutPath: "jfred",
        parentOccurrenceId: "root",
        pathInParent: "jfred",
        depth: 1,
    });
    const jfredToolsPlugin = makeOccurrence({
        occurrenceId: "jfredToolsPlugin",
        checkoutPath: "jfred/jfredToolsPlugin",
        parentOccurrenceId: "jfred",
        pathInParent: "jfredToolsPlugin",
        depth: 2,
    });
    const tmuxLib = makeOccurrence({
        occurrenceId: "tmuxLib",
        checkoutPath: "jfred/jfredToolsPlugin/external/tmux_lib",
        parentOccurrenceId: "jfredToolsPlugin",
        pathInParent: "external/tmux_lib",
        depth: 3,
    });
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [root, jfred, jfredToolsPlugin, tmuxLib],
    };

    const result = validateRepositoryManifest(manifest);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(manifest.occurrences.length, 4);
    assert.equal(tmuxLib.parentOccurrenceId, jfredToolsPlugin.occurrenceId);
    assert.ok(
        !manifest.occurrences.some((o) => o.checkoutPath === "jfred/jfredToolsPlugin/external"),
    );
});
