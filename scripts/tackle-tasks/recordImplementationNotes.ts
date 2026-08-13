// "record implementation notes file" — plans/tackle-tasks-v1_5-plan.md Phase 3. Rejects a path
// that does not exist inside the worktree: a recorded-but-missing path makes
// "is the previous run's work resumable?" lie later. F5/F7: the same shared containment
// predicate isTaskRunResumable uses, so a symlink escape is rejected here too, not just on read.
import { readFileSync } from "node:fs";
import { updateCurrentTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { isNotesFileContained } from "./isTaskRunResumable.ts";

export type RecordImplementationNotesOutput = { implementationNotesFile: string };

export function recordImplementationNotes(
    taskNumber: number,
    worktreePath: string,
    implementationNotesFile: string,
    runId: string,
    projectRoot: string,
): RecordImplementationNotesOutput {
    if (!isNotesFileContained(worktreePath, implementationNotesFile)) {
        throw new Error(`"${implementationNotesFile}" is not a path inside the worktree "${worktreePath}"`);
    }
    updateCurrentTaskRun(taskNumber, runId, { implementationNotesFile }, projectRoot);
    return { implementationNotesFile };
}

export type RecordImplementationNotesCliInput = {
    taskNumber: number;
    worktreePath: string;
    implementationNotesFile: string;
    runId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("recordImplementationNotes.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RecordImplementationNotesCliInput;
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const output = recordImplementationNotes(
        input.taskNumber, worktreePath, input.implementationNotesFile, input.runId, projectRoot,
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
