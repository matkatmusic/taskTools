// "auto generate docs" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { readFileSync } from "node:fs";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "./writeTaskBrief.ts";

export type GenerateTaskDocsOutput = { briefFile: string };

export function generateTaskDocs(taskNumber: number, worktreePath: string, projectRoot: string): GenerateTaskDocsOutput {
    configureGeneratedArtifactIsolation(taskNumber, worktreePath);
    const briefFile = writeTaskBriefToDisk(taskNumber, worktreePath, projectRoot);
    return { briefFile };
}

export type GenerateTaskDocsCliInput = { taskNumber: number; worktreePath: string; projectRoot: string };

if (process.argv[1]?.endsWith("generateTaskDocs.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as GenerateTaskDocsCliInput;
    const output = generateTaskDocs(input.taskNumber, input.worktreePath, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
