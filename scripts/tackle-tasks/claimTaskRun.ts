// "claim the task" — pipeline.mmd. Wraps taskRunState.claimTask, the atomic claim that
// doubles as the already-active check (rule 12 covers the closing case).
import { readFileSync } from "node:fs";
import { claimTask } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type ClaimTaskRunOutput = {
    status: "claimed" | "refused" | "closing" | "not-found";
    heldByRunId: string | null;
};

export function claimTaskRun(taskNumber: number, runId: string, projectRoot: string): ClaimTaskRunOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    return {
        status: outcome.status,
        heldByRunId: outcome.status === "refused" ? outcome.heldByRunId : null,
    };
}

if (process.argv[1]?.endsWith("claimTaskRun.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; runId: string; projectRoot: string };
    const output = claimTaskRun(input.taskNumber, input.runId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
