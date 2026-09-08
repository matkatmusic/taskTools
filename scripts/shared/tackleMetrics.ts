// Appends one JSON line per pipeline run to plans/tackle-metrics.jsonl. Timestamps make runs comparable to plans/tackle-baseline.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowArguments } from "./prepareTasks.ts";

export type RunMetricsRecord = {
    runId: string;
    startTimestamp: string | null;
    endTimestamp: string;
    durationMs: number | null;
    taskNumbers: number[];
    groupCount: number;
    doneCount: number;
    partialCount: number;
    blockedCount: number;
    needsClarificationCount: number;
    requeueCount: number;
    conflictCount: number;
    argumentsHash: string;
};

// Null start means the run predates timestamp carry-through, or the workflow dropped it.
export function runDurationMs(startTimestamp: string | null, endTimestamp: string): number | null {
    if (!startTimestamp) return null;
    const start = Date.parse(startTimestamp);
    const end = Date.parse(endTimestamp);
    return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

export function computeArgumentsHash(workflowArguments: WorkflowArguments): string {
    return createHash("sha256").update(JSON.stringify(workflowArguments)).digest("hex");
}

export function appendRunMetricsRecord(repoRoot: string, record: RunMetricsRecord): void {
    const metricsPath = join(repoRoot, "plans", "tackle-metrics.jsonl");
    mkdirSync(dirname(metricsPath), { recursive: true });
    appendFileSync(metricsPath, JSON.stringify(record) + "\n");
}
