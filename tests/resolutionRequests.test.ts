// resolutionRequests.ts: resumable discovery resolution requests with persisted answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResolutionManifest } from "../scripts/resolutionRequests.ts";
import {
    createResolutionRequest,
    createResolutionRequestId,
    createEmptyResolutionManifest,
    recordResolutionRequest,
    applyResolutionAnswers,
    needsResolutionRequest,
    createBaseReconciliationRequest,
    recordBaseReconciliationRequest,
    applyBaseReconciliationAnswers,
    REASON_ZERO_EXACT_TIP_MATCHES,
    REASON_MULTIPLE_EXACT_TIP_MATCHES,
    REASON_BASE_RECONCILIATION,
} from "../scripts/resolutionRequests.ts";

// Zero exact tip matches: request carries that reason and an empty candidate list.
test("createResolutionRequest records zero-exact-tip-match reason", () => {
    const request = createResolutionRequest("occ-1", "abc123", [], REASON_ZERO_EXACT_TIP_MATCHES);
    assert.equal(request.occurrenceId, "occ-1");
    assert.equal(request.recordedOid, "abc123");
    assert.deepEqual(request.candidateBaseBranches, []);
    assert.equal(request.reason, REASON_ZERO_EXACT_TIP_MATCHES);
    assert.ok(request.id.length > 0);
});

// Multiple exact tip matches: request carries that reason and every candidate branch.
test("createResolutionRequest records multiple-exact-tip-match reason", () => {
    const request = createResolutionRequest("occ-2", "def456", ["main", "develop"], REASON_MULTIPLE_EXACT_TIP_MATCHES);
    assert.equal(request.reason, REASON_MULTIPLE_EXACT_TIP_MATCHES);
    assert.deepEqual(request.candidateBaseBranches, ["main", "develop"]);
});

// A resumed run re-derives the same request; it must not be duplicated in the manifest.
test("recordResolutionRequest is idempotent for a repeated id", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createResolutionRequest("occ-3", "abc123", [], REASON_ZERO_EXACT_TIP_MATCHES);
    recordResolutionRequest(manifest, request);
    recordResolutionRequest(manifest, request);
    assert.equal(manifest.resolutionRequests.length, 1);
});

// A valid answer for a recorded request's id gets persisted in the manifest.
test("applyResolutionAnswers stores the answer in the manifest", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createResolutionRequest("occ-4", "abc123", ["main"], REASON_ZERO_EXACT_TIP_MATCHES);
    recordResolutionRequest(manifest, request);
    applyResolutionAnswers(manifest, { [request.id]: "main" });
    assert.equal(manifest.resolutionAnswers[request.id], "main");
});

// An answer naming a non-candidate branch must be rejected and not persisted.
test("applyResolutionAnswers rejects a branch not among the candidates", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createResolutionRequest("occ-5", "abc123", ["main", "develop"], REASON_ZERO_EXACT_TIP_MATCHES);
    recordResolutionRequest(manifest, request);
    assert.throws(() => applyResolutionAnswers(manifest, { [request.id]: "feature-x" }));
    assert.equal(manifest.resolutionAnswers[request.id], undefined);
});

// Second discovery pass: once a question is answered, no request is needed for it.
test("needsResolutionRequest is false once an answer is stored", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createResolutionRequest("occ-6", "abc123", ["main"], REASON_ZERO_EXACT_TIP_MATCHES);
    recordResolutionRequest(manifest, request);
    assert.equal(needsResolutionRequest(manifest, "occ-6", REASON_ZERO_EXACT_TIP_MATCHES), true);
    applyResolutionAnswers(manifest, { [request.id]: "main" });
    assert.equal(needsResolutionRequest(manifest, "occ-6", REASON_ZERO_EXACT_TIP_MATCHES), false);
});

// After a JSON round trip, recomputing the id must still match the stored id.
test("resolution request id is stable across a JSON round trip", () => {
    const idBefore = createResolutionRequestId("occ-7", REASON_MULTIPLE_EXACT_TIP_MATCHES);
    const manifest = createEmptyResolutionManifest();
    const request = createResolutionRequest("occ-7", "abc123", ["main", "develop"], REASON_MULTIPLE_EXACT_TIP_MATCHES);
    recordResolutionRequest(manifest, request);

    const roundTripped: ResolutionManifestForTest = JSON.parse(JSON.stringify(manifest));
    const idAfter = createResolutionRequestId(
        roundTripped.resolutionRequests[0].occurrenceId,
        roundTripped.resolutionRequests[0].reason
    );

    assert.equal(idBefore, idAfter);
    assert.equal(idAfter, roundTripped.resolutionRequests[0].id);
});

interface ResolutionManifestForTest {
    resolutionRequests: { id: string; occurrenceId: string; reason: string }[];
}

// Same generalized id function as occurrence-scoped requests — proves the id is stable, not a second id scheme.
test("createResolutionRequestId is stable when keyed by a logical repository id", () => {
    const idBefore = createResolutionRequestId("repo-e", REASON_BASE_RECONCILIATION);
    const idAfter = createResolutionRequestId("repo-e", REASON_BASE_RECONCILIATION);
    assert.equal(idBefore, idAfter);
    const request = createBaseReconciliationRequest("repo-e", []);
    assert.equal(request.id, idBefore);
});

// Every member's full {occurrenceId, recordedOid, baseBranch} record must survive retrieval unchanged.
test("recordBaseReconciliationRequest persists the full member payload", () => {
    const manifest = createEmptyResolutionManifest();
    const members = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ];
    const request = createBaseReconciliationRequest("repo-f", members);
    recordBaseReconciliationRequest(manifest, request);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, members);
});

// A changed occurrence set for the same repository overwrites the one entry, not a second one.
test("recordBaseReconciliationRequest refreshes a changed member list under the stable id", () => {
    const manifest = createEmptyResolutionManifest();
    const firstMembers = [{ occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" }];
    recordBaseReconciliationRequest(manifest, createBaseReconciliationRequest("repo-c", firstMembers));
    const secondMembers = [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "abc123", baseBranch: "feature-x" },
    ];
    recordBaseReconciliationRequest(manifest, createBaseReconciliationRequest("repo-c", secondMembers));
    assert.equal(manifest.baseReconciliationRequests.length, 1);
    assert.deepEqual(manifest.baseReconciliationRequests[0].members, secondMembers);
});

// A structured answer round-trips through JSON as a single {recordedOid, baseBranch}
// value, not two separately-keyed fields that could desync.
test("applyBaseReconciliationAnswers answer survives a JSON round trip", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-a", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    applyBaseReconciliationAnswers(manifest, { [request.id]: { recordedOid: "abc123", baseBranch: "main" } });
    const roundTripped: ResolutionManifest = JSON.parse(JSON.stringify(manifest));
    assert.deepEqual(roundTripped.baseReconciliationAnswers[request.id], { recordedOid: "abc123", baseBranch: "main" });
});

// Mixing one member's OID with another's baseBranch was never recorded together; reject as one unit.
test("applyBaseReconciliationAnswers rejects a cross-member OID/base pair", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-b", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
        { occurrenceId: "occ-2", recordedOid: "def456", baseBranch: "develop" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    const crossedPair = { recordedOid: "abc123", baseBranch: "develop" };
    assert.throws(() => applyBaseReconciliationAnswers(manifest, { [request.id]: crossedPair }));
    assert.equal(manifest.baseReconciliationAnswers[request.id], undefined);
});

// Legacy string-answer function must reject a reconciliation id by name, not the generic not-found error.
test("applyResolutionAnswers explicitly rejects a base-reconciliation request id", () => {
    const manifest = createEmptyResolutionManifest();
    const request = createBaseReconciliationRequest("repo-d", [
        { occurrenceId: "occ-1", recordedOid: "abc123", baseBranch: "main" },
    ]);
    recordBaseReconciliationRequest(manifest, request);
    assert.throws(
        () => applyResolutionAnswers(manifest, { [request.id]: "main" }),
        /base-reconciliation/
    );
});
