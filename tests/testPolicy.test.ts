// Behavioral checks for testPolicy.ts: per-occurrence test command discovery. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverTestPolicy,
    REASON_NO_TEST_CONFIGURATION,
    REASON_AMBIGUOUS_RELATED_TEST_COMMAND,
} from "../scripts/testPolicy.ts";
import { createEmptyResolutionManifest } from "../scripts/resolutionRequests.ts";

function withTempDir(body: (dirPath: string) => void): void {
    const dirPath = mkdtempSync(join(tmpdir(), "test-policy-"));
    try {
        body(dirPath);
    } finally {
        rmSync(dirPath, { recursive: true, force: true });
    }
}

function writePackageJson(dirPath: string, scripts: Record<string, string>): void {
    writeFileSync(join(dirPath, "package.json"), JSON.stringify({ scripts }));
}

test("test_missingPackageJsonProducesResolutionRequest", () => {
    withTempDir((dirPath) => {
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, []);
    });
});

test("test_packageJsonWithoutTestScriptProducesResolutionRequest", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { build: "tsc" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, []);
    });
});

test("test_unambiguousTestScriptIsDiscoveredAndRecorded", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "resolved");
        if (result.status !== "resolved") return;
        assert.equal(result.policy.occurrenceId, "occ-1");
        assert.equal(result.policy.completeSuiteCommand, "npm run test");
        assert.equal(result.policy.relatedTestCommand, result.policy.completeSuiteCommand);
    });
});

test("test_unambiguousRelatedScriptIsRecordedSeparatelyFromCompleteSuite", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run", "test:related": "vitest related" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "resolved");
        if (result.status !== "resolved") return;
        assert.equal(result.policy.completeSuiteCommand, "npm run test");
        assert.equal(result.policy.relatedTestCommand, "npm run test:related");
    });
});

test("test_twoEquallyPlausibleRelatedCandidatesProduceResolutionRequest", () => {
    withTempDir((dirPath) => {
        writeFileSync(
            join(dirPath, "package.json"),
            JSON.stringify({ scripts: { test: "x", "test:changed": "b", "test:related": "a" } })
        );
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_AMBIGUOUS_RELATED_TEST_COMMAND);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, ["test:related", "test:changed"]);
    });
});

test("test_persistedAnswerIsReusedOnNextRunForAmbiguousCandidates", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "x", "test:related": "a", "test:changed": "b" });
        const manifest = createEmptyResolutionManifest();
        const firstResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(firstResult.status, "needsResolution");
        if (firstResult.status !== "needsResolution") return;
        const requestId = firstResult.resolutionRequests[0].id;
        manifest.resolutionAnswers[requestId] = "test:changed";

        const secondResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(secondResult.status, "resolved");
        if (secondResult.status !== "resolved") return;
        assert.equal(secondResult.policy.relatedTestCommand, "npm run test:changed");
        assert.equal(secondResult.policy.completeSuiteCommand, "npm run test");
    });
});

test("test_persistedAnswerIsReusedOnNextRunForMissingConfiguration", () => {
    withTempDir((dirPath) => {
        const manifest = createEmptyResolutionManifest();
        const firstResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(firstResult.status, "needsResolution");
        if (firstResult.status !== "needsResolution") return;
        const requestId = firstResult.resolutionRequests[0].id;
        manifest.resolutionAnswers[requestId] = "npm run custom-test";

        const secondResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(secondResult.status, "resolved");
        if (secondResult.status !== "resolved") return;
        assert.equal(secondResult.policy.relatedTestCommand, "npm run custom-test");
        assert.equal(secondResult.policy.completeSuiteCommand, "npm run custom-test");
    });
});

test("test_occurrencesOfOneLogicalRepositoryCarrySamePolicyWhileRecordedSeparately", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run" });
        const manifest = createEmptyResolutionManifest();
        const resultA = discoverTestPolicy("occ-a", dirPath, manifest);
        const resultB = discoverTestPolicy("occ-b", dirPath, manifest);
        assert.equal(resultA.status, "resolved");
        assert.equal(resultB.status, "resolved");
        if (resultA.status !== "resolved" || resultB.status !== "resolved") return;
        assert.notEqual(resultA.policy.occurrenceId, resultB.policy.occurrenceId);
        assert.equal(resultA.policy.relatedTestCommand, resultB.policy.relatedTestCommand);
        assert.equal(resultA.policy.completeSuiteCommand, resultB.policy.completeSuiteCommand);
    });
});
