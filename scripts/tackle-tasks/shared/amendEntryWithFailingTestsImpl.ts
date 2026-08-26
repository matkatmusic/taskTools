// "amend tasks.json entry with the failing tests" — pipeline-taskTests.mmd. The implementer reads the entry next.
//
// Shared by scripts/tackle-tasks/amendEntryWithFailingTests.ts (the old CLI entrypoint, still
// dispatched by path from ImplementBodyEmitter.ts) and
// scripts/steps/pipeline-taskTests/AMEND_ENTRY_WITH_FAILING_TESTS.ts (the run-step block).
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

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
