// Appends one JSON line per pipeline run to plans/tackle-metrics.jsonl for later comparison against plans/tackle-baseline.jsonl and across runs.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkflowArguments } from "./prepareTasks.ts";

export type RunMetricsRecord = {
    runId: string;
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

export function computeArgumentsHash(workflowArguments: WorkflowArguments): string {
    return createHash("sha256").update(JSON.stringify(workflowArguments)).digest("hex");
}

export function appendRunMetricsRecord(repoRoot: string, record: RunMetricsRecord): void {
    const metricsPath = join(repoRoot, "plans", "tackle-metrics.jsonl");
    mkdirSync(dirname(metricsPath), { recursive: true });
    appendFileSync(metricsPath, JSON.stringify(record) + "\n");
}
