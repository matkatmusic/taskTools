// Behavioral checks for tackleMetrics.ts: append-only metrics log, deterministic hash.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "../scripts/tackleMetrics.ts";
import type { WorkflowArguments } from "../scripts/prepareTasks.ts";

function makeRecord(runId: string) {
    return {
        runId,
        startTimestamp: "2026-07-31T08:35:13.335Z",
        endTimestamp: "2026-07-31T08:41:13.335Z",
        durationMs: 360_000,
        taskNumbers: [1],
        groupCount: 1,
        doneCount: 1,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        conflictCount: 0,
        argumentsHash: "hash",
    };
}

test("test_appendRunMetricsRecordAddsOneLinePerRunWithoutErasingEarlierLines", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "tackle-metrics-"));
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    const metricsPath = join(repoRoot, "plans", "tackle-metrics.jsonl");
    writeFileSync(metricsPath, JSON.stringify(makeRecord("run-1")) + "\n");

    appendRunMetricsRecord(repoRoot, makeRecord("run-2"));

    const lines = readFileSync(metricsPath, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).runId, "run-1");
    assert.equal(JSON.parse(lines[1]).runId, "run-2");
});

test("test_runDurationMsMeasuresTheGapBetweenPreparationAndMerge", () => {
    assert.equal(runDurationMs("2026-07-31T08:35:13.335Z", "2026-07-31T08:41:13.335Z"), 360_000);
});

test("test_runDurationMsIsNullWhenNoStartTimestampWasCarriedThrough", () => {
    assert.equal(runDurationMs(null, "2026-07-31T08:41:13.335Z"), null);
});

test("test_runDurationMsIsNullWhenEitherTimestampIsUnparseable", () => {
    assert.equal(runDurationMs("not-a-date", "2026-07-31T08:41:13.335Z"), null);
});

test("test_computeArgumentsHashReturnsTheSameHashForIdenticalArguments", () => {
    const workflowArguments: WorkflowArguments = {
        repo: "/tmp/repo",
        typecheckCommand: "npx tsc --noEmit",
        groups: [{ groupId: 1, worktree: "/tmp/wt", branch: "task-group-1", scope: "unknown", tasks: [] }],
    };
    const other: WorkflowArguments = JSON.parse(JSON.stringify(workflowArguments));
    assert.equal(computeArgumentsHash(workflowArguments), computeArgumentsHash(other));
});
