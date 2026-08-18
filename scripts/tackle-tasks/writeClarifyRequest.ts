// "write the clarify request into the tasks.json entry" — pipeline-plan.mmd. The planner reads the entry next.
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";

export type WriteClarifyRequestInput = {
    projectRoot: string;
    taskNumber: number;
    clarifyRequest: string;
};

export type WriteClarifyRequestOutput = { written: boolean; clarifyRequest: string };

export function writeClarifyRequest(input: WriteClarifyRequestInput): WriteClarifyRequestOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const clarifyRequest = input.clarifyRequest.trim();
    if (clarifyRequest === "") throw new Error(`write-clarify-request: task ${input.taskNumber} sent an empty request`);

    const pair = resolveTaskFiles(projectRoot);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task: any) => task.taskNumber === input.taskNumber);
        if (!entry) throw new Error(`task ${input.taskNumber} not found in ${pair.tasksPath}`);
        (entry as any).clarifyRequest = clarifyRequest;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
    return { written: true, clarifyRequest };
}

if (process.argv[1]?.endsWith("writeClarifyRequest.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as WriteClarifyRequestInput;
    process.stdout.write(`${JSON.stringify(writeClarifyRequest(input))}\n`);
}
