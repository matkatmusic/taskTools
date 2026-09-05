// "where are we?" — decides how /run-step continues a task that has already started once. plans/resume-failed-run-plan.md §0/§3.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import { isTaskNumberValid } from "./isTaskNumberValid.ts";
import { readTaskRunState, reopenTaskRun, endTaskRun } from "./taskRunState.ts";
import { writeTaskExitNotes } from "./writeTaskExitNotes.ts";
import { readRetainedResetIntent } from "./resetIntent.ts";
import { acquireSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";
import { checkpointPath, readCheckpoint, writeCheckpoint, type Checkpoint } from "./checkpoint.ts";

export function findResumeEntry(taskNumber: number, tasksFile: string): { block: string; input: string } | null {
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    if (!isTaskNumberValid(taskNumber, projectRoot).valid) return null; // row 1

    const state = readTaskRunState(taskNumber, projectRoot);
    const newest = state.history[state.history.length - 1] ?? null;
    if (newest !== null && newest.tailCursor) { // row 0: an exit-tail cursor always outranks the worktree checkpoint
        return { block: newest.tailCursor.block, input: newest.tailCursor.input };
    }
    const worktree = state.worktree;
    const usableWorktree = worktree !== null && existsSync(worktree) && existsSync(checkpointPath(worktree));

    if (usableWorktree) {
        const checkpoint = readCheckpoint(worktree)!; // row 2
        prepareResume(checkpoint);
        markCheckpointResumed(worktree, checkpoint);
        return { block: checkpoint.block, input: checkpoint.input };
    }

    if (newest !== null && newest.exitType === "completed") { // row 3
        const input = JSON.stringify({
            box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            projectRoot, taskNumber, runId: newest.runId,
        });
        // Always BUILD_CLOSURE_NOTE, active or not: ARCHIVE_TASK needs a closureNote this packet
        // never carries, and BUILD_CLOSURE_NOTE / MARK_TASK_INACTIVE_SUCCESS are both idempotent,
        // so replaying them before ARCHIVE_TASK is always safe (MSE-19).
        return { block: "pipeline-mergeSucceededExit.mmd::BUILD_CLOSURE_NOTE", input };
    }

    if (state.active) { // row 4
        if (worktree !== null) {
            const resetIntent = readRetainedResetIntent(worktree);
            if (resetIntent !== null && resetIntent.runId === newest!.runId) {
                const input = JSON.stringify({
                    box: "TAKE_WORKTREE_LEASE_BEFORE_RESET", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
                    taskNumber, runId: newest!.runId, projectRoot,
                    worktree: resetIntent.worktreePath, branch: resetIntent.branch,
                    docsMode: "", planFile: "", exitType: "", exitNote: "",
                });
                return { block: "pipeline-preambleStatusCheck.mmd::RESET_WORKTREE", input };
            }
        }
        writeTaskExitNotes({
            taskNumber, runId: newest!.runId, projectRoot,
            exitType: "agent-failed", exitNote: "run stopped before a worktree existed",
        });
        endTaskRun(taskNumber, newest!.runId, projectRoot);
        return null;
    }

    return null; // row 5
}

export function prepareResume(checkpoint: Pick<Checkpoint, "taskNumber" | "runId" | "projectRoot" | "sourceLockHeld">): void {
    const { taskNumber, runId, projectRoot, sourceLockHeld } = checkpoint;
    reopenTaskRun(taskNumber, runId, projectRoot);

    const worktree = readTaskRunState(taskNumber, projectRoot).worktree!;
    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktree));
    if (owner === null || owner.runId !== runId) {
        throw new Error(`resume: worktree lease for task ${taskNumber} names run ${owner === null ? "none" : owner.runId}, not ${runId}`);
    }

    if (sourceLockHeld) {
        const outcome = acquireSourceRepoLock(projectRoot, buildLockOwner(runId, taskNumber));
        if (outcome.status === "acquired" || outcome.status === "already-held-by-me") return;
        throw new Error(`resume: source repo lock is held by ${outcome.owner}`);
    }
}

// Finds the most recently logged input for `box` under `runId`, so /run-step can start a fresh walk at any block in an existing run.
export function findStartAtBlockEntry(
    taskNumber: number,
    tasksFile: string,
    box: string,
    runLogFolder: string,
): { input: string; runId: string; projectRoot: string } | null {
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const state = readTaskRunState(taskNumber, projectRoot);
    const newest = state.history[state.history.length - 1];
    if (newest === undefined) return null;

    const worktree = state.worktree;
    if (worktree === null || !existsSync(worktree)) return null;
    if (!existsSync(join(worktree, "plans", "plan.json"))) return null;
    if (!existsSync(join(worktree, "plans", `brief-${taskNumber}.md`))) return null;

    // const header = `## ======= ${box} =======`;
    let foundInput: string | null = null;

    // const logFileNames = readdirSync(runLogFolder).filter((name) => name.endsWith("run-log.md")).sort();
    // for (const logFileName of logFileNames) {
    //     const lines = readFileSync(join(runLogFolder, logFileName), "utf8").split("\n");
    //     for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    //         if (lines[lineIndex] !== header) continue;
    //
    //         let commandLine: string | null = null;
    //         for (let searchIndex = lineIndex + 1; searchIndex < lines.length; searchIndex++) {
    //             if (lines[searchIndex] === "### === command ======") {
    //                 commandLine = lines[searchIndex + 1];
    //                 break;
    //             }
    //         }
    //         if (commandLine === null) continue;
    //         ...
    //     }
    // }

    // The command string now comes from the newest packet naming this box, for this run, across every stamp folder in the runs folder.
    const packetNamePattern = new RegExp(`^${box}-\\d+-\\d+\\.json$`);
    let newestMtimeMs = -Infinity;
    for (const stampEntry of readdirSync(runLogFolder)) {
        const packetsFolder = join(runLogFolder, stampEntry, "packets");
        if (!existsSync(packetsFolder)) continue; // a stamp folder with no packets folder is a normal state after a run that died before its first block
        for (const packetName of readdirSync(packetsFolder)) {
            if (!packetNamePattern.test(packetName)) continue;
            const packetPath = join(packetsFolder, packetName);
            const commandLine = (JSON.parse(readFileSync(packetPath, "utf8")) as { command: string }).command;

            const quoteStart = commandLine.indexOf("'");
            if (quoteStart === -1) continue;

            let raw = "";
            let charIndex = quoteStart + 1;
            while (charIndex < commandLine.length) {
                if (commandLine.slice(charIndex, charIndex + 4) === `'\\''`) {
                    raw += "'";
                    charIndex += 4;
                    continue;
                }
                if (commandLine[charIndex] === "'") break;
                raw += commandLine[charIndex];
                charIndex += 1;
            }

            const parsed = JSON.parse(raw) as { runId?: string };
            if (parsed.runId !== newest.runId) continue;

            const mtimeMs = statSync(packetPath).mtimeMs;
            if (mtimeMs <= newestMtimeMs) continue;
            newestMtimeMs = mtimeMs;
            foundInput = raw;
        }
    }

    if (foundInput === null) return null;
    return { input: foundInput, runId: newest.runId, projectRoot };
}

// A failure exit always becomes resumedFrom; a kill records itself only when nothing is there yet, so a scrap survives later kills.
export function markCheckpointResumed(worktree: string, checkpoint: Checkpoint): void {
    const keepExisting = checkpoint.state === "running" && checkpoint.resumedFrom !== null;
    writeCheckpoint(worktree, {
        ...checkpoint,
        state: "running",
        resumedFrom: keepExisting
            ? checkpoint.resumedFrom
            : { block: checkpoint.block, exitType: checkpoint.exitType, exitNote: checkpoint.exitNote },
    });
}
