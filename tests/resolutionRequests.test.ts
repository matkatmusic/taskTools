// resolutionRequests.ts: resumable discovery resolution requests with persisted answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createResolutionRequest,
    createResolutionRequestId,
    createEmptyResolutionManifest,
    recordResolutionRequest,
    applyResolutionAnswers,
    needsResolutionRequest,
    REASON_ZERO_EXACT_TIP_MATCHES,
    REASON_MULTIPLE_EXACT_TIP_MATCHES,
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
