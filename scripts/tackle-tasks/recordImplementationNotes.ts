// "record implementation notes file" — plans/tackle-tasks-v1_5-plan.md Phase 3. Rejects a path
// that does not exist inside the worktree: a recorded-but-missing path makes
// "is the previous run's work resumable?" lie later.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { updateCurrentTaskRun } from "./taskRunState.ts";

export type RecordImplementationNotesOutput = { implementationNotesFile: string };

export function recordImplementationNotes(
    taskNumber: number,
    worktreePath: string,
    implementationNotesFile: string,
    projectRoot: string,
): RecordImplementationNotesOutput {
    const fullPath = isAbsolute(implementationNotesFile)
        ? implementationNotesFile
        : join(worktreePath, implementationNotesFile);
    const relativePath = relative(worktreePath, fullPath);
    if (relativePath.startsWith("..") || !existsSync(fullPath)) {
        throw new Error(`"${implementationNotesFile}" is not a path inside the worktree "${worktreePath}"`);
    }
    updateCurrentTaskRun(taskNumber, { implementationNotesFile }, projectRoot);
    return { implementationNotesFile };
}

export type RecordImplementationNotesCliInput = {
    taskNumber: number;
    worktreePath: string;
    implementationNotesFile: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("recordImplementationNotes.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RecordImplementationNotesCliInput;
    const output = recordImplementationNotes(
        input.taskNumber, input.worktreePath, input.implementationNotesFile, input.projectRoot,
    );
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
