// Covers the two pieces of step-6 logic that used to be prose in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeOutcomes, hasLapRemaining, judgeMergeRun, MAX_LAPS, resolveMergeVerdict, type MergePhaseVerdict, type MergeRetryDeps } from "../scripts/runMergePhase.ts";
import { buildOperationPushOccurrences } from "../scripts/operationBranches.ts";
import type { CliInput } from "../scripts/mergePipeline.ts";

test("test_buildMergeOutcomesDerivesCountsFromTheStepArrays", () => {
    const outcomes = buildMergeOutcomes({
        done: [1, 2, 3],
        partial: [4],
        blocked: [],
        needsClarification: [5, 6],
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });

    assert.deepEqual(outcomes, {
        doneCount: 3,
        partialCount: 1,
        blockedCount: 0,
        needsClarificationCount: 2,
        requeueCount: 2,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    });
});

test("test_buildMergeOutcomesTreatsEveryMissingStepAsZero", () => {
    assert.deepEqual(buildMergeOutcomes({}), {
        doneCount: 0,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        testReceipts: [],
        reviewHandoffs: [],
    });
});

test("test_hasLapRemainingAllowsExactlyTwoLapsThenStops", () => {
    assert.equal(MAX_LAPS, 2);
    assert.equal(hasLapRemaining(0), true);
    assert.equal(hasLapRemaining(1), true);
    assert.equal(hasLapRemaining(2), false);
});

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [{ branch: "new-usage-graph" }] });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "merged");
    assert.equal(verdict.failure, null);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsNonZero", () => {
    const verdict = judgeMergeRun({ exitCode: 1, stdout: "", stderr: "boom" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.equal(verdict.failure?.error, "1: boom");
    assert.deepEqual(verdict.failure?.conflicts, []);
    assert.equal(verdict.failure?.failedCommand, "cmd");
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButReportsConflicts", () => {
    const conflicts = [{ groupId: 1, merged: false }];
    const verdict = judgeMergeRun({ exitCode: 0, stdout: JSON.stringify({ merged: [], conflicts }), stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.deepEqual(verdict.failure?.conflicts, conflicts);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptPrintsSomethingOtherThanJson", () => {
    const verdict = judgeMergeRun({ exitCode: 0, stdout: "Debugger attached.", stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /not JSON/);
});

test("test_judgeMergeRunReportsBlockedWhenTheScriptExitsCleanButPublishedNothing", () => {
    const stdout = JSON.stringify({ merged: [{ groupId: 1 }], conflicts: [], publicationTargets: [], runState: { status: "approved" } });
    const verdict = judgeMergeRun({ exitCode: 0, stdout, stderr: "" }, "/repo", "cmd");

    assert.equal(verdict.status, "blocked");
    assert.match(verdict.failure?.error ?? "", /published nothing/);
});

test("test_resolveMergeVerdictRetriesWithPopulatedOperationBranchesOnConfirmedBaseDrift", () => {
    const occurrence: CliInput["repositoryManifest"]["occurrences"][number] = {
        occurrenceId: "", checkoutPath: "/tmp/repo", parentOccurrenceId: null, pathInParent: null,
        gitlinkOid: null, depth: 0, originUrl: "", baseBranch: "main", baseOid: "oldoid",
        operationBranch: "", childOccurrenceIds: [], testState: "untested",
    };
    const [populatedOccurrence] = buildOperationPushOccurrences([occurrence], "oldrun123");
    const group: CliInput["groups"][number] = { groupId: 1, worktree: "/tmp/repo", branch: "task-group-1", scope: "declared", tasks: [] };
    const runArguments: CliInput = {
        repo: "/tmp/repo", typecheckCommand: "true",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch: "main" }],
        runId: "oldrun123",
        repositoryManifest: { version: 1, occurrences: [populatedOccurrence] },
    };
    const deps: MergeRetryDeps = {
        runScript: () => ({ exitCode: 0, stdout: JSON.stringify({ conflicts: [], publicationTargets: [{ x: 1 }] }), stderr: "" }),
        generateRunId: () => "newrun456",
        readRefOid: () => "deadbeef",
        writeRunArguments: () => {},
        rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
        discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
    };
    const initialVerdict: MergePhaseVerdict = {
        status: "blocked",
        result: { abortReason: "the source branch moved past the pinned baseOid" },
        failure: { repo: "/tmp/repo", failedCommand: "cmd", conflicts: [], error: "" },
    };

    const verdict = resolveMergeVerdict(initialVerdict, () => runArguments, ["node", "merge"], deps);

    assert.equal(verdict.status, "merged");
});

test("test_resolveMergeVerdictDoesNotReadRunArgumentsWhenInitialVerdictIsNotConfirmedBaseDrift", () => {
    const mergedVerdict: MergePhaseVerdict = { status: "merged", result: { conflicts: [], publicationTargets: [{ x: 1 }] }, failure: null };
    let readCount = 0;
    const readRunArguments = () => {
        readCount++;
        throw new Error("must not read run-arguments.json: mergePipeline.ts deletes it after a successful merge");
    };
    const deps: MergeRetryDeps = {
        runScript: () => { throw new Error("must not run the merge command again"); },
        generateRunId: () => "unused",
        readRefOid: () => "unused",
        writeRunArguments: () => {},
        rebaseGroupOntoSource: () => ({ status: "rebased-clean" }),
        discoverTestPolicy: () => ({ status: "resolved", policy: { occurrenceId: "", relatedTestCommand: "true", completeSuiteCommand: "true" } }),
    };

    const verdict = resolveMergeVerdict(mergedVerdict, readRunArguments, ["node", "merge"], deps);

    assert.equal(readCount, 0);
    assert.equal(verdict, mergedVerdict);
});
