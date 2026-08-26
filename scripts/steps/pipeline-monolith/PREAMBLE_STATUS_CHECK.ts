// PREAMBLE_STATUS_CHECK, from _pipeline-monolith.mmd. Absorbs pipeline-preambleStatusCheck.mmd and pipeline-worktreeCheck.mmd.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { deleteTaskMergePersistence, removeWorktreeAndBranch } from "../../mergeTaskWorktrees.ts";
import { releaseTaskWorktreeLease } from "../../prepareTasks.ts";
import { checkResumedWorktreeFence } from "../../tackle-tasks/checkResumedWorktreeFence.ts";
import { checkTaskWorktreeSafe } from "../../tackle-tasks/checkTaskWorktreeSafe.ts";
import { taskBranchName } from "../../tackle-tasks/createTaskWorktree.ts";
import { doesTaskWorktreeExist } from "../../tackle-tasks/doesTaskWorktreeExist.ts";
import { initTaskSubmodules } from "../../tackle-tasks/initTaskSubmodules.ts";
import { isTaskBlocked } from "../../tackle-tasks/isTaskBlocked.ts";
import { isTaskNumberValid } from "../../tackle-tasks/isTaskNumberValid.ts";
import { isTaskRunResumable } from "../../tackle-tasks/isTaskRunResumable.ts";
import { claimTask, readTaskRunState, transitionWorktreeLease, updateCurrentTaskRun } from "../../tackle-tasks/taskRunState.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";
import { createFreshTaskWorktree } from "./_createFreshTaskWorktree.ts";
import type { EntryPacket } from "./_packet.ts";

// The workflow's first input: the same two fields PREAMBLE_TASK_NUMBER_INPUT took.
type Input = { taskNumber: number; tasksFile: string };

export function main(input: string): EntryPacket & { next: string } {
    const { taskNumber, tasksFile } = JSON.parse(input) as Input;
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const packet: EntryPacket = {
        box: "PREAMBLE_STATUS_CHECK",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber,
        runId: "",
        projectRoot,
        worktree: "",
        branch: taskBranchName(taskNumber),
        docsMode: "",
        planFile: "",
        exitType: "",
        exitNote: "",
    };

    // Task status: three report-only exits, then mark the task active.
    if (!isTaskNumberValid(taskNumber, projectRoot).valid) {
        return { ...packet, exitType: "invalid-number", exitNote: "task number is not in tasks.json", next: "REPORT_ONLY_EXIT" };
    }
    if (isTaskBlocked(taskNumber, projectRoot).blocked) {
        return { ...packet, exitType: "blocked", exitNote: "an open blocker remains", next: "REPORT_ONLY_EXIT" };
    }
    if (readTaskRunState(taskNumber, projectRoot).active) {
        return { ...packet, exitType: "already-active", exitNote: "a previous run left the task active", next: "REPORT_ONLY_EXIT" };
    }
    const runId = randomUUID();
    const claim = claimTask(taskNumber, runId, projectRoot);
    if (claim.status !== "claimed") {
        throw new Error(`task ${taskNumber} could not be marked active: ${claim.status}`);
    }

    // Worktree status: fresh, resumed, or reset. Each path settles worktree and docsMode.
    let worktree: string;
    let docsMode: string;
    const existing = doesTaskWorktreeExist(taskNumber, projectRoot);
    if (existing.exists) {
        const existingWorktree = existing.worktree as string;
        if (checkTaskWorktreeSafe(taskNumber, existingWorktree).safe) {
            // isTaskRunResumable adopts the lease before it answers.
            if (!isTaskRunResumable(taskNumber, existingWorktree, runId, projectRoot).resumable) {
                return {
                    ...packet, runId, worktree: existingWorktree, exitType: "not-resumable",
                    exitNote: "a safe worktree holds work no run recorded a stopping point for", next: "FAILURES_EXIT",
                };
            }
            const fence = checkResumedWorktreeFence({ projectRoot, worktreePath: existingWorktree, taskNumber });
            if (!fence.inside) {
                return {
                    ...packet, runId, worktree: existingWorktree, exitType: "fence-violation",
                    exitNote: `the resumed worktree touched files the task does not own: ${fence.violations.join(", ")}`, next: "FAILURES_EXIT",
                };
            }
            worktree = existingWorktree;
            docsMode = "UPDATE";
        } else {
            const lease = transitionWorktreeLease(taskNumber, runId, projectRoot);
            if (lease.status === "refused-owner-mismatch") {
                throw new Error(`worktree lease for task ${taskNumber} is held by run "${lease.heldByRunId}", refusing reset`);
            }
            if (lease.status === "adopted") {
                const state = readTaskRunState(taskNumber, projectRoot);
                if (state.worktree !== null) {
                    releaseTaskWorktreeLease({ worktreePath: state.worktree, runId });
                }
            }
            deleteTaskMergePersistence(projectRoot, packet.branch);
            removeWorktreeAndBranch(projectRoot, existingWorktree, packet.branch);
            worktree = createFreshTaskWorktree(taskNumber, runId, projectRoot);
            updateCurrentTaskRun(taskNumber, runId, { worktree, leaseRunId: runId }, projectRoot);
            docsMode = "AUTOGEN";
        }
    } else {
        worktree = createFreshTaskWorktree(taskNumber, runId, projectRoot);
        updateCurrentTaskRun(taskNumber, runId, { worktree, leaseRunId: runId }, projectRoot);
        docsMode = "AUTOGEN";
    }

    initTaskSubmodules({ worktreePath: worktree, taskNumber, runId, projectRoot, stepId: "init-submodules" });
    return { ...packet, runId, worktree, docsMode, next: "DOCUMENT_GENERATION" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
