// "update auto generated docs" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { readFileSync } from "node:fs";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "./writeTaskBrief.ts";
import { logStepOutput } from "./logStepOutput.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

export type UpdateTaskDocsOutput = { briefFile: string };

export function updateTaskDocs(taskNumber: number, worktreePath: string, projectRoot: string): UpdateTaskDocsOutput {
    configureGeneratedArtifactIsolation(taskNumber, worktreePath);
    const briefFile = writeTaskBriefToDisk(taskNumber, worktreePath, projectRoot);
    return { briefFile };
}

export type UpdateTaskDocsCliInput = { taskNumber: number; worktreePath: string; projectRoot: string };

const UPDATE_TASK_DOCS_SOURCE = "scripts/tackle-tasks/updateTaskDocs.ts:9: updateTaskDocs";

if (process.argv[1]?.endsWith("updateTaskDocs.ts")) {
    const stdinText = readFileSync(0, "utf8");
    const input = JSON.parse(stdinText) as UpdateTaskDocsCliInput & { boxId?: string };
    const boxId = input.boxId ?? "UPDATE_AUTO_GENERATED_DOCS";
    const runId = getCurrentTaskRun(input.taskNumber, input.projectRoot)?.runId ?? "unknown-run";
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId };
    const command = `node ${process.argv[1]} <<'TTDOCS'\n${stdinText}\nTTDOCS`;
    try {
        const output = updateTaskDocs(input.taskNumber, input.worktreePath, input.projectRoot);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: UPDATE_TASK_DOCS_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: UPDATE_TASK_DOCS_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
