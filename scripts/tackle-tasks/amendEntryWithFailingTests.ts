// "amend tasks.json entry with the failing tests" — pipeline-taskTests.mmd. The implementer reads the entry next.
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type AmendEntryInput = { projectRoot: string; taskNumber: number };
export type AmendEntryOutput = { amended: boolean; notes: string };

export function amendEntryWithFailingTests(input: AmendEntryInput): AmendEntryOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    // Derived here, never accepted from the caller: the run that judged the tests recorded the output.
    const taskTests = getCurrentTaskRun(input.taskNumber, projectRoot)?.taskTests;
    if (!taskTests) throw new Error(`amend-entry: task ${input.taskNumber} has no recorded task-test run`);
    if (taskTests.passed) throw new Error(`amend-entry: the recorded task tests for ${input.taskNumber} passed; this box runs only on red tests`);

    const notes = `The task tests failed. Fix the cause, and change no test.\n\n${taskTests.output}`;
    const pair = resolveTaskFiles(projectRoot);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task: any) => task.taskNumber === input.taskNumber);
        if (!entry) throw new Error(`task ${input.taskNumber} not found in ${pair.tasksPath}`);
        (entry as any).codexReviewNotes = notes;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
    return { amended: true, notes };
}

const AMEND_ENTRY_WITH_FAILING_TESTS_SOURCE = "scripts/tackle-tasks/amendEntryWithFailingTests.ts:11: amendEntryWithFailingTests";

if (process.argv[1]?.endsWith("amendEntryWithFailingTests.ts")) {
    const argv = process.argv.slice(2);
    const [projectRoot, taskNumber] = argv;
    const N = Number(taskNumber);
    const input = { projectRoot, taskNumber: N };
    const identity = { projectRoot, taskNumber: N, runId: getCurrentTaskRun(N, projectRoot)!.runId };
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
    const command = `node ${process.argv[1]} ${argv.map(quote).join(" ")}`;

    try {
        const output = amendEntryWithFailingTests(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId: "AMEND_ENTRY_WITH_FAILING_TESTS", source: AMEND_ENTRY_WITH_FAILING_TESTS_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId: "AMEND_ENTRY_WITH_FAILING_TESTS", source: AMEND_ENTRY_WITH_FAILING_TESTS_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
