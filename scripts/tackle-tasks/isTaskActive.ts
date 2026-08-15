// "is the task active?" — pipeline-preamble.mmd. Atomic check-and-mark; rule 12 covers closing.
import { readFileSync } from "node:fs";
import { claimTask } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type IsTaskActiveOutput = {
    status: "claimed" | "refused" | "closing" | "not-found";
    heldByRunId: string | null;
    reason: string | null;
};

export function isTaskActive(taskNumber: number, runId: string, projectRoot: string): IsTaskActiveOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    if (outcome.status === "refused") {
        return { status: outcome.status, heldByRunId: outcome.heldByRunId, reason: `is already active in run ${outcome.heldByRunId}` };
    }
    if (outcome.status === "closing") {
        return { status: outcome.status, heldByRunId: null, reason: "is closing" };
    }
    if (outcome.status === "not-found") {
        return { status: outcome.status, heldByRunId: null, reason: "not found in `.taskTools/tasks.json`" };
    }
    return { status: outcome.status, heldByRunId: null, reason: null };
}

if (process.argv[1]?.endsWith("isTaskActive.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; runId: string; projectRoot: string };
    const output = isTaskActive(input.taskNumber, input.runId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
