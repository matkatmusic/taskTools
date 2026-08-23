// "write the clarify request into the tasks.json entry" — pipeline-plan.mmd. The planner reads the entry next.
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
import { logStepOutput } from "./logStepOutput.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

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

const WRITE_CLARIFY_REQUEST_SOURCE = "scripts/tackle-tasks/writeClarifyRequest.ts:17: writeClarifyRequest";

if (process.argv[1]?.endsWith("writeClarifyRequest.ts")) {
    const stdinText = readFileSync(0, "utf8");
    const input = JSON.parse(stdinText) as WriteClarifyRequestInput & { boxId?: string };
    const boxId = input.boxId ?? "WRITE_CLARIFY_REQUEST";
    const runId = getCurrentTaskRun(input.taskNumber, input.projectRoot)?.runId ?? "unknown-run";
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId };
    const command = `node ${process.argv[1]} <<'TTCLARIFY'\n${stdinText}\nTTCLARIFY`;
    try {
        const output = writeClarifyRequest(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: WRITE_CLARIFY_REQUEST_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: WRITE_CLARIFY_REQUEST_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
