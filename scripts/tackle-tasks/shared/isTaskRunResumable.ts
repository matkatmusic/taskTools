// plans/tackle-tasks-v1_5-plan.md Phase 3, F7; phase10-audit.md Finding 1: lease ownership is established before deciding resumability.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { acquireAbsentWorktreeLease, adoptWorktreeLease, readTaskRunState } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { NOTES_FILE_CONTAINED, NOTES_FILE_NOT_CONTAINED } from "../../resultCodes.ts";

export type IsTaskRunResumableOutput = {
    resumable: boolean;
    implementationNotesFile: string | null;
    leaseEstablished: boolean;
};

const NOT_RESUMABLE: IsTaskRunResumableOutput = {
    resumable: false, implementationNotesFile: null, leaseEstablished: false,
};

// F5/F7: containment check shared by recordImplementationNotes.ts and reconcileStep.ts so all four handlers agree.
export function isNotesFileContained(worktreePath: string, notesFile: string): number {
    const notesPath = isAbsolute(notesFile) ? notesFile : join(worktreePath, notesFile);
    if (!existsSync(notesPath)) return NOTES_FILE_NOT_CONTAINED;
    let realWorktree: string;
    let realNotesPath: string;
    try {
        realWorktree = realpathSync(worktreePath);
        realNotesPath = realpathSync(notesPath);
    } catch {
        return NOTES_FILE_NOT_CONTAINED;
    }
    if (!statSync(realNotesPath).isFile()) return NOTES_FILE_NOT_CONTAINED;
    return realNotesPath.startsWith(`${realWorktree}${sep}`) ? NOTES_FILE_CONTAINED : NOTES_FILE_NOT_CONTAINED;
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
    // An ended run that never implemented anything left no work to lose, so a fresh plan may start here.
    const noWorkRecorded = newest !== undefined && notesFile === null && newest.modifiedFiles.length === 0 && newest.commits.length === 0;
    if (noWorkRecorded) return { resumable: true, implementationNotesFile: null, leaseEstablished: true };
    if (notesFile === null || isNotesFileContained(worktreePath, notesFile) !== NOTES_FILE_CONTAINED) {
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
