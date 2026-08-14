// "update auto generated docs" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { readFileSync } from "node:fs";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "./writeTaskBrief.ts";

export type UpdateTaskDocsOutput = { briefFile: string };

export function updateTaskDocs(taskNumber: number, worktreePath: string, projectRoot: string): UpdateTaskDocsOutput {
    configureGeneratedArtifactIsolation(taskNumber, worktreePath);
    const briefFile = writeTaskBriefToDisk(taskNumber, worktreePath, projectRoot);
    return { briefFile };
}

export type UpdateTaskDocsCliInput = { taskNumber: number; worktreePath: string; projectRoot: string };

if (process.argv[1]?.endsWith("updateTaskDocs.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as UpdateTaskDocsCliInput;
    const output = updateTaskDocs(input.taskNumber, input.worktreePath, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
