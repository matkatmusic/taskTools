// Behavioral checks for approvalGate.ts: single whole-run approval gate, digest, drift invalidation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeApprovalDigest,
    recordApproval,
    issueApprovalAuthorization,
    checkAuthorizationDrift,
    finalizeApprovedRun,
} from "../scripts/approvalGate.ts";
import type { ApprovalDigestInput, RunState } from "../scripts/approvalGate.ts";

function baselineDigestInput(): ApprovalDigestInput {
    return {
        manifest: { version: 1, occurrences: [] },
        files: ["a.ts"],
        operationRef: "refs/operation/1",
        baseRef: "refs/heads/main",
        occurrenceDigests: ["occ-digest-1"],
        testReceipts: [{ groupId: "group-1", status: "green" }],
        reviewHandoffs: ["handoff-1"],
    };
}

function baselineRunState(overrides: Partial<RunState> = {}): RunState {
    return {
        readyForApproval: true,
        status: "review",
        digestInput: baselineDigestInput(),
        ...overrides,
    };
}

function approvedAndAuthorizedRunState(): RunState {
    const runState = baselineRunState();
    recordApproval(runState);
    issueApprovalAuthorization(runState);
    return runState;
}

test("test_computeApprovalDigest_isDeterministicForSameInputs", () => {
    // Hashing the same input object twice must produce the identical digest.
    const input = baselineDigestInput();
    const first = computeApprovalDigest(input);
    const second = computeApprovalDigest(input);
    assert.equal(first, second);
});

test("test_computeApprovalDigest_changesWhenManifestChanges", () => {
    // Mutating only the manifest must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.manifest = { version: 2, occurrences: [] };
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenAFileChanges", () => {
    // Mutating only the files list must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.files = [...mutated.files, "b.ts"];
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenOperationRefChanges", () => {
    // Mutating only operationRef must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.operationRef = "refs/operation/2";
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenBaseRefChanges", () => {
    // Mutating only baseRef must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.baseRef = "refs/heads/other";
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenAnOccurrenceDigestChanges", () => {
    // Mutating only one occurrence digest must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.occurrenceDigests = ["occ-digest-2"];
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenATestReceiptChanges", () => {
    // Mutating only one test receipt must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.testReceipts = [{ groupId: "group-1", status: "red" }];
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_computeApprovalDigest_changesWhenAReviewHandoffChanges", () => {
    // Mutating only the review handoffs must change the digest from the baseline.
    const baseline = computeApprovalDigest(baselineDigestInput());
    const mutated = baselineDigestInput();
    mutated.reviewHandoffs = ["handoff-2"];
    assert.notEqual(computeApprovalDigest(mutated), baseline);
});

test("test_recordApproval_throwsWhenNotReadyForApproval", () => {
    // A run that is not readyForApproval must reject recordApproval.
    const runState = baselineRunState({ readyForApproval: false });
    assert.throws(() => recordApproval(runState));
});

test("test_recordApproval_succeedsWhenReadyForApproval_andStoresDigest", () => {
    // A ready run records an approval carrying the digest of its current state.
    const runState = baselineRunState();
    const approval = recordApproval(runState);
    assert.equal(runState.approval, approval);
    assert.equal(approval.digest, computeApprovalDigest(runState.digestInput));
    assert.equal(typeof approval.recordedAt, "string");
});

test("test_recordApproval_rejectsSecondApprovalForSameRun", () => {
    // A run that already has an approval must reject a second recordApproval call.
    const runState = baselineRunState();
    recordApproval(runState);
    assert.throws(() => recordApproval(runState));
});

test("test_issuedAuthorization_carriesRecordedDigest", () => {
    // The authorization issued after recordApproval must carry the recorded digest.
    const runState = baselineRunState();
    const approval = recordApproval(runState);
    const authorization = issueApprovalAuthorization(runState);
    assert.equal(authorization.stateDigest, approval.digest);
});

test("test_driftInvalidatesAuthorization_whenFileChanges", () => {
    // Changing a file after authorization is issued must invalidate it and return to review.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.files = [...runState.digestInput.files, "new-file.ts"];
    const valid = checkAuthorizationDrift(runState);
    assert.equal(valid, false);
    assert.equal(runState.authorization, undefined);
    assert.equal(runState.status, "review");
});

test("test_driftInvalidatesAuthorization_whenRefChanges", () => {
    // Changing baseRef after authorization is issued must invalidate it and return to review.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.baseRef = "refs/heads/mutated";
    const valid = checkAuthorizationDrift(runState);
    assert.equal(valid, false);
    assert.equal(runState.authorization, undefined);
    assert.equal(runState.status, "review");
});

test("test_driftInvalidatesAuthorization_whenOccurrenceDigestChanges", () => {
    // Changing an occurrence digest after authorization is issued must invalidate it and return to review.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.occurrenceDigests = ["occ-digest-mutated"];
    const valid = checkAuthorizationDrift(runState);
    assert.equal(valid, false);
    assert.equal(runState.authorization, undefined);
    assert.equal(runState.status, "review");
});

test("test_driftInvalidatesAuthorization_whenTestReceiptChanges", () => {
    // Changing a test receipt after authorization is issued must invalidate it and return to review.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.testReceipts = [{ groupId: "group-1", status: "red" }];
    const valid = checkAuthorizationDrift(runState);
    assert.equal(valid, false);
    assert.equal(runState.authorization, undefined);
    assert.equal(runState.status, "review");
});

test("test_driftInvalidatesAuthorization_whenReviewHandoffChanges", () => {
    // Changing a review handoff after authorization is issued must invalidate it and return to review.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.reviewHandoffs = ["handoff-mutated"];
    const valid = checkAuthorizationDrift(runState);
    assert.equal(valid, false);
    assert.equal(runState.authorization, undefined);
    assert.equal(runState.status, "review");
});

test("test_finalizer_rejectsStaleAuthorization", () => {
    // A valid authorization whose backing state has since drifted must be rejected by the finalizer.
    const runState = approvedAndAuthorizedRunState();
    runState.digestInput.baseRef = "refs/heads/mutated";
    assert.throws(() => finalizeApprovedRun(runState, { runId: "run-stale", occurrences: [] }));
});

test("test_onlyOneApprovalGateExistsAcrossRun", () => {
    // Full sequence ready -> record -> issue -> finalize; a second recordApproval must still hit the single gate.
    const runState = baselineRunState();
    recordApproval(runState);
    issueApprovalAuthorization(runState);
    finalizeApprovedRun(runState, { runId: "run-once", occurrences: [] });
    assert.throws(() => recordApproval(runState));
});
