// Behavioral checks for approvalReadiness.ts: readiness gating and reviewer exercise-method handoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    assessApprovalReadiness,
    isActionableExerciseMethod,
    reviewGroupExerciseMethod,
} from "../scripts/approvalReadiness.ts";
import type { ApprovalReadinessInput } from "../scripts/approvalReadiness.ts";
import { computeOccurrenceDigests } from "../scripts/approvalGate.ts";
import type { OccurrenceSnapshot } from "../scripts/approvalGate.ts";

function baseGreenInput(): ApprovalReadinessInput {
    return {
        groupIds: ["group-1"],
        selectedTasks: [{ taskId: 1, state: "done" }],
        ownership: { passed: true },
        typecheck: { passed: true },
        occurrenceConvergence: { converged: true },
        testReceipts: [{ groupId: "group-1", status: "green" }],
        groupReviews: [
            {
                groupId: "group-1",
                methods: [{ kind: "command", command: "npx tsc --noEmit", workingDirectory: "/repo" }],
            },
        ],
    };
}

test("test_partialTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "partial" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("partial"));
});

test("test_blockedTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "blocked" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("blocked"));
});

test("test_clarificationNeededTaskPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.selectedTasks = [{ taskId: 1, state: "needs-clarification" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("clarification"));
});

test("test_ownershipViolationPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.ownership = { passed: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("ownership"));
});

test("test_typecheckFailurePreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.typecheck = { passed: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("typecheck"));
});

test("test_unconvergedOccurrencePreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.occurrenceConvergence = { converged: false };
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("sync"));
});

test("test_redTestReceiptPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.testReceipts = [{ groupId: "group-1", status: "red" }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("test"));
});

test("test_missingTestReceiptPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.testReceipts = [];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("test"));
});

test("test_missingGroupReviewPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.groupReviews = [];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("missing-review"));
});

test("test_nonActionableGroupReviewPreventsReadyForApproval", () => {
    const input = baseGreenInput();
    input.groupReviews = [{ groupId: "group-1", methods: [{ kind: "note", text: "looks good" }] }];
    const result = assessApprovalReadiness(input);
    assert.equal(result.readyForApproval, false);
    assert.ok(result.blockedBy.includes("non-actionable-review"));
});

test("test_fullyGreenRunWithActionableMethodPerGroupIsReadyForApproval", () => {
    const result = assessApprovalReadiness(baseGreenInput());
    assert.equal(result.readyForApproval, true);
    assert.deepEqual(result.blockedBy, []);
});

test("test_liveServerUrlMethodIsActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "url", url: "http://localhost:3000" }), true);
});

test("test_commandWithWorkingDirectoryIsActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "command", command: "bun test", workingDirectory: "/repo" }), true);
});

test("test_commandWithoutWorkingDirectoryIsNotActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "command", command: "bun test", workingDirectory: "" }), false);
});

test("test_proseOnlyNoteIsNotActionable", () => {
    assert.equal(isActionableExerciseMethod({ kind: "note", text: "looks fine" }), false);
});

test("test_reviewerReturnsUrlWhenLiveServerUrlFactProvided", () => {
    const result = reviewGroupExerciseMethod({
        groupId: "group-1",
        workingDirectory: "/repo",
        liveServerUrl: "http://localhost:4000",
    });
    assert.ok(result.methods.some((method) => method.kind === "url" && isActionableExerciseMethod(method)));
});

test("test_reviewerReturnsCommandWhenVerificationCommandFactProvided", () => {
    const result = reviewGroupExerciseMethod({
        groupId: "group-1",
        workingDirectory: "/repo",
        verificationCommand: "npx tsc --noEmit",
    });
    const method = result.methods.find((candidate) => candidate.kind === "command");
    assert.ok(method && isActionableExerciseMethod(method));
    assert.equal(method?.kind === "command" ? method.workingDirectory : undefined, "/repo");
});

test("test_reviewerReturnsNonActionableNoteWhenNoFactsProvided", () => {
    const result = reviewGroupExerciseMethod({ groupId: "group-1", workingDirectory: "/repo" });
    assert.equal(result.methods.length, 1);
    assert.equal(result.methods[0].kind, "note");
    assert.equal(isActionableExerciseMethod(result.methods[0]), false);
});

test("test_reviewerPerformsNoWrites", async () => {
    const { default: fs } = await import("node:fs");
    const writeShapedMethods = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "rm", "rmSync"] as const;
    const originals = writeShapedMethods.map((name) => [name, (fs as Record<string, unknown>)[name]] as const);
    for (const name of writeShapedMethods) {
        (fs as Record<string, unknown>)[name] = () => {
            throw new Error(`unexpected write-shaped fs call: ${name}`);
        };
    }
    try {
        const result = reviewGroupExerciseMethod({
            groupId: "group-1",
            workingDirectory: "/repo",
            liveServerUrl: "http://localhost:4000",
        });
        assert.equal(result.groupId, "group-1");
    } finally {
        for (const [name, original] of originals) (fs as Record<string, unknown>)[name] = original;
    }
});

test("test_occurrenceDigestOrderIsSortedByGroupIdThenRepositoryPath", () => {
    const reversed: OccurrenceSnapshot[] = [
        { groupId: 2, repositoryPath: "sub", treeListing: "b" },
        { groupId: 1, repositoryPath: "sub", treeListing: "a" },
        { groupId: 1, repositoryPath: "", treeListing: "c" },
    ];
    const forward: OccurrenceSnapshot[] = [
        { groupId: 1, repositoryPath: "", treeListing: "c" },
        { groupId: 1, repositoryPath: "sub", treeListing: "a" },
        { groupId: 2, repositoryPath: "sub", treeListing: "b" },
    ];
    assert.deepEqual(computeOccurrenceDigests(reversed), computeOccurrenceDigests(forward));
});

test("test_occurrenceDigestChangesWithTreeListingContent", () => {
    const base: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob abc\tfile.ts\0" }];
    const changed: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob def\tfile.ts\0" }];
    assert.notEqual(computeOccurrenceDigests(base)[0], computeOccurrenceDigests(changed)[0]);
});

test("test_occurrenceDigestHandlesDeletionAsAbsentTreeEntry", () => {
    const withFile: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "100644 blob abc\tfile.ts\0" }];
    const withoutFile: OccurrenceSnapshot[] = [{ groupId: 1, repositoryPath: "", treeListing: "" }];
    assert.notEqual(computeOccurrenceDigests(withFile)[0], computeOccurrenceDigests(withoutFile)[0]);
});

test("test_occurrenceDigestHandlesGitlinkEntryDeterministically", () => {
    const snapshot: OccurrenceSnapshot = { groupId: 1, repositoryPath: "", treeListing: "160000 commit abc123\tsub\0" };
    assert.equal(computeOccurrenceDigests([snapshot])[0], computeOccurrenceDigests([snapshot])[0]);
});
