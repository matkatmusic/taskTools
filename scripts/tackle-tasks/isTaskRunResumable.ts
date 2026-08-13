// "is the previous run's work resumable?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
// F7: the notes file must resolve, by real path, to a regular file inside the real worktree —
// that one check handles an absolute outside path, a "../" escape and a symlink escape alike.
// Ownership must be established (adopted from an ended owner, or freshly acquired for an
// absent lease) before resumable is ever reported true.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { acquireAbsentWorktreeLease, adoptWorktreeLease, readTaskRunState } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type IsTaskRunResumableOutput = {
    resumable: boolean;
    implementationNotesFile: string | null;
    leaseEstablished: boolean;
};

const NOT_RESUMABLE: IsTaskRunResumableOutput = {
    resumable: false, implementationNotesFile: null, leaseEstablished: false,
};

// F5/F7: the one read-only realpath + regular-file containment predicate. Shared with
// recordImplementationNotes.ts (the mutating write side) and reconcileStep.ts's resumability and
// notes-recording handlers, so all four cannot drift on what "inside the worktree" means.
export function isNotesFileContained(worktreePath: string, notesFile: string): boolean {
    const notesPath = isAbsolute(notesFile) ? notesFile : join(worktreePath, notesFile);
    if (!existsSync(notesPath)) return false;
    let realWorktree: string;
    let realNotesPath: string;
    try {
        realWorktree = realpathSync(worktreePath);
        realNotesPath = realpathSync(notesPath);
    } catch {
        return false;
    }
    if (!statSync(realNotesPath).isFile()) return false;
    return realNotesPath.startsWith(`${realWorktree}${sep}`);
}

export function isTaskRunResumable(
    taskNumber: number,
    worktreePath: string,
    runId: string,
    projectRoot: string,
): IsTaskRunResumableOutput {
    const state = readTaskRunState(taskNumber, projectRoot);
    const endedRuns = state.history.filter((run) => run.endedAt !== null);
    const newest = endedRuns[endedRuns.length - 1];
    const notesFile = newest?.implementationNotesFile ?? null;
    if (notesFile === null) return NOT_RESUMABLE;
    if (!isNotesFileContained(worktreePath, notesFile)) return NOT_RESUMABLE;

    const { adopted } = adoptWorktreeLease(taskNumber, runId, projectRoot);
    if (adopted) return { resumable: true, implementationNotesFile: notesFile, leaseEstablished: true };

    const { acquired } = acquireAbsentWorktreeLease(taskNumber, runId, projectRoot);
    if (acquired) return { resumable: true, implementationNotesFile: notesFile, leaseEstablished: true };

    return NOT_RESUMABLE;
}

export type IsTaskRunResumableCliInput = {
    taskNumber: number;
    worktreePath: string;
    runId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("isTaskRunResumable.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as IsTaskRunResumableCliInput;
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const output = isTaskRunResumable(input.taskNumber, worktreePath, input.runId, projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
