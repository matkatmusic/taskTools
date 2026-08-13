// "record implementation notes file" — plans/tackle-tasks-v1_5-plan.md Phase 3. Rejects a path
// that does not exist inside the worktree: a recorded-but-missing path makes
// "is the previous run's work resumable?" lie later. F7: the same realpathSync containment
// check isTaskRunResumable uses, so a symlink escape is rejected here too, not just on read.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { updateCurrentTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type RecordImplementationNotesOutput = { implementationNotesFile: string };

export function recordImplementationNotes(
    taskNumber: number,
    worktreePath: string,
    implementationNotesFile: string,
    runId: string,
    projectRoot: string,
): RecordImplementationNotesOutput {
    const fullPath = isAbsolute(implementationNotesFile)
        ? implementationNotesFile
        : join(worktreePath, implementationNotesFile);
    if (!existsSync(fullPath)) {
        throw new Error(`"${implementationNotesFile}" is not a path inside the worktree "${worktreePath}"`);
    }
    const realWorktree = realpathSync(worktreePath);
    const realNotesPath = realpathSync(fullPath);
    if (!statSync(realNotesPath).isFile() || !realNotesPath.startsWith(`${realWorktree}${sep}`)) {
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
