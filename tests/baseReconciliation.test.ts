// baseReconciliation.ts: base/recorded-OID reconciliation gate for repeated repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmptyResolutionManifest, applyBaseReconciliationAnswers, createBaseReconciliationRequest, recordBaseReconciliationRequest } from "../scripts/resolutionRequests.ts";
import { checkBaseReconciliation, assertBaseReconciled } from "../scripts/baseReconciliation.ts";

// Zero occurrences is a caller bug, not a reconciliation question — fail loudly.
test("checkBaseReconciliation throws when given zero occurrences", () => {
    const manifest = createEmptyResolutionManifest();
    assert.throws(() => checkBaseReconciliation("repo-g", [], manifest));
});

// A persisted answer wins even when the occurrences it was recorded against disagree.
test("checkBaseReconciliation resolves from a persisted answer over disagreeing occurrences", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const request = createBaseReconciliationRequest("repo-h", occurrences);
    recordBaseReconciliationRequest(manifest, request);
    applyBaseReconciliationAnswers(manifest, { [request.id]: { recordedOid: "abc123", baseBranch: "main" } });
    const result = checkBaseReconciliation("repo-h", occurrences, manifest);
    assert.deepEqual(result, { status: "resolved", recordedOid: "abc123", baseBranch: "main" });
});

// All occurrences already agree — resolve without ever creating a resolution request.
test("checkBaseReconciliation resolves when occurrences are unanimous", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "abc123", baseBranch: "main" },
    ];
    const result = checkBaseReconciliation("repo-i", occurrences, manifest);
    assert.deepEqual(result, { status: "resolved", recordedOid: "abc123", baseBranch: "main" });
    assert.equal(manifest.baseReconciliationRequests.length, 0);
});

// Disagreeing occurrences with no persisted answer block, and exactly one request is recorded carrying every occurrence's full payload.
test("checkBaseReconciliation blocks and records one request when occurrences disagree", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const result = checkBaseReconciliation("repo-j", occurrences, manifest);
    assert.equal(result.status, "blocked");
    assert.equal(manifest.baseReconciliationRequests.length, 1);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, occurrences);
});

// Same occurrence set, different input order — persisted member order must be identical both times.
test("checkBaseReconciliation normalizes member order before persisting", () => {
    const manifestA = createEmptyResolutionManifest();
    const manifestB = createEmptyResolutionManifest();
    const forward = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const reversed = [...forward].reverse();
    checkBaseReconciliation("repo-k", forward, manifestA);
    checkBaseReconciliation("repo-k", reversed, manifestB);
    assert.deepEqual(manifestA.baseReconciliationRequests[0].members, manifestB.baseReconciliationRequests[0].members);
});

// On the resolved path, callers get the plain pair directly, no status field to check.
test("assertBaseReconciled returns the resolved pair directly", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [{ occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" }];
    const choice = assertBaseReconciled("repo-l", occurrences, manifest);
    assert.deepEqual(choice, { recordedOid: "abc123", baseBranch: "main" });
});

// On the blocked path assertBaseReconciled throws, naming both the logical repository id and the request id.
test("assertBaseReconciled throws naming both the logical repository id and the request id", () => {
    const manifest = createEmptyResolutionManifest();
    const occurrences = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    assert.throws(() => assertBaseReconciled("repo-m", occurrences, manifest), (error: Error) => {
        assert.match(error.message, /repo-m/);
        const requestId = createBaseReconciliationRequest("repo-m", occurrences).id;
        assert.match(error.message, new RegExp(requestId));
        return true;
    });
});
