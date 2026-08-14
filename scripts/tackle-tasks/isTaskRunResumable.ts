// "is the previous run's work resumable?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
// F7: the notes file must resolve, by real path, to a regular file inside the real worktree —
// that one check handles an absolute outside path, a "../" escape and a symlink escape alike.
// Finding 1 (phase10-audit.md): ownership is established FIRST, independent of resumability.
// Every existing-worktree path — safe or not — must adopt an ended owner's lease or acquire an
// absent one before anything else happens, so a "safe, no notes" run is never left proceeding
// against a lease still naming a dead run. Only once ownership is established do we decide
// resumable from the newest ended run's notes file. Neither the notes file's absence nor its
// failing containment ever blocks lease establishment.
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
    const { adopted } = adoptWorktreeLease(taskNumber, runId, projectRoot);
    const leaseEstablished = adopted || acquireAbsentWorktreeLease(taskNumber, runId, projectRoot).acquired;
    if (!leaseEstablished) return NOT_RESUMABLE;

    const state = readTaskRunState(taskNumber, projectRoot);
    const endedRuns = state.history.filter((run) => run.endedAt !== null);
    const newest = endedRuns[endedRuns.length - 1];
    const notesFile = newest?.implementationNotesFile ?? null;
    if (notesFile === null || !isNotesFileContained(worktreePath, notesFile)) {
        return { resumable: false, implementationNotesFile: null, leaseEstablished: true };
    }
    return { resumable: true, implementationNotesFile: notesFile, leaseEstablished: true };
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
