# Task 13: Base and recorded-OID reconciliation gate for repeated repositories

Phase 2 of the recursive repository-discovery redesign. AMENDED — follow plans/amended task 13.md; it supersedes plans/task-13-plan.md.

This is no longer a new-module-only task. scripts/resolutionRequests.ts must be extended first: its Phase 1 contract keys requests by (occurrenceId, reason) and types answers as Record<string, string>, which cannot express a logical-repository question or a structured {recordedOid, baseBranch} answer. Do not JSON-encode a choice into a string, substitute a logical repository ID into occurrenceId, or serialize members into candidateBaseBranches.

Add a discriminated base-reconciliation request family (REASON_BASE_RECONCILIATION, BaseReconciliationRequest keyed by logicalRepositoryId, BaseReconciliationChoice) alongside the existing branch-selection request, widen the manifest to persist both, and generalize createResolutionRequestId's parameter from occurrenceId to subjectId with byte-identical output. Existing string-answer creation, validation, and IDs stay green; a reconciliation request passed to the legacy string-answer path is rejected explicitly. applyBaseReconciliationAnswers accepts an answer only when its complete {recordedOid, baseBranch} pair appears in one member record, persists it atomically, does not duplicate an unanswered request, and refreshes a changed member list under the stable ID.

Then scripts/baseReconciliation.ts: checkBaseReconciliation(logicalRepositoryId, occurrences, manifest) takes the manifest explicitly and returns a resolved {recordedOid, baseBranch} or blocked {logicalRepositoryId, requestId}; assertBaseReconciled narrows and throws naming both. Order: persisted typed answer wins, then unanimous occurrences, else create/refresh one request. Require at least one occurrence; normalize member order before persisting. Blocking is a hard precondition — no synchronization, worker edits, or branch creation while unresolved.

No production call sites in this task.

Tests: the seven original behavioral tests amended to pass a ResolutionManifest, plus request-ID stability keyed to the logical repository, full member payload persistence, structured answer surviving a JSON round trip, rejection of a cross-member OID/base pair never recorded together, non-duplicating deterministic re-record, existing string-answer suite still green, and explicit rejection of a reconciliation request by the legacy function.

### scripts/resolutionRequests.ts

```
// resolutionRequests.ts: resumable discovery resolution requests with persisted answers.
import { createHash } from "node:crypto";

export type ResolutionReason = string;

export const REASON_ZERO_EXACT_TIP_MATCHES: ResolutionReason = "zero-exact-tip-matches";
export const REASON_MULTIPLE_EXACT_TIP_MATCHES: ResolutionReason = "multiple-exact-tip-matches";

export interface ResolutionRequest {
    id: string;
    occurrenceId: string;
    recordedOid: string;
    candidateBaseBranches: string[];
    reason: ResolutionReason;
}

export interface ResolutionManifest {
    resolutionRequests: ResolutionRequest[];
    resolutionAnswers: Record<string, string>;
}

export function createResolutionRequestId(occurrenceId: string, reason: ResolutionReason): string {
    const hash = createHash("sha256").update(`${occurrenceId}::${reason}`).digest("hex");
    return `rr_${hash.slice(0, 16)}`;
}

export function createEmptyResolutionManifest(): ResolutionManifest {
    return { resolutionRequests: [], resolutionAnswers: {} };
}

export function createResolutionRequest(
    occurrenceId: string,
    recordedOid: string,
    candidateBaseBranches: string[],
    reason: ResolutionReason
): ResolutionRequest {
    return {
        id: createResolutionRequestId(occurrenceId, reason),
        occurrenceId,
        recordedOid,
        candidateBaseBranches,
        reason,
    };
}

export function recordResolutionRequest(manifest: ResolutionManifest, request: ResolutionRequest): void {
    const alreadyRecorded = manifest.resolutionRequests.some((existing) => existing.id === request.id);
    if (alreadyRecorded) return;
    manifest.resolutionRequests.push(request);
}

export function hasResolutionAnswer(manifest: ResolutionManifest, requestId: string): boolean {
    return Object.prototype.hasOwnProperty.call(manifest.resolutionAnswers, requestId);
}

export function needsResolutionRequest(
    manifest: ResolutionManifest,
    occurrenceId: string,
    reason: ResolutionReason
): boolean {
    const id = createResolutionRequestId(occurrenceId, reason);
    return !hasResolutionAnswer(manifest, id);
}

export function applyResolutionAnswers(manifest: ResolutionManifest, answers: Record<string, string>): void {
    for (const [requestId, selectedBranch] of Object.entries(answers)) {
        const request = manifest.resolutionRequests.find((candidate) => candidate.id === requestId);
        if (!request) {
            throw new Error(`No resolution request found with id "${requestId}"`);
        }
        if (!request.candidateBaseBranches.includes(selectedBranch)) {
            throw new Error(
                `"${selectedBranch}" is not among the candidate base branches for request "${requestId}": ${request.candidateBaseBranches.join(", ")}`
            );
        }
        manifest.resolutionAnswers[requestId] = selectedBranch;
    }
}

```

### tests/resolutionRequests.test.ts

```
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

```

### scripts/baseReconciliation.ts

(missing: file not found on disk)

### tests/baseReconciliation.test.ts

(missing: file not found on disk)
