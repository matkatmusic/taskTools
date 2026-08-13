// "create a worktree" — plans/tackle-tasks-v1_5-plan.md Phase 3.
//
// F11: createWorktreeForGroup creates the real git worktree and takes its lease before this
// function can record task.run.worktree/leaseRunId. If that recording write fails, the
// conventional path would otherwise hold an unrecorded worktree and lease that
// doesTaskWorktreeExist can never see (it only trusts task state) and that nothing would
// ever release. So: journal the create intent first, and on a state-write failure roll back
// only what this exact operation created (release its lease, remove its worktree/branch). If
// even that rollback fails, the journal is left in place — its shape is the exact receipt
// Phase 8 reconciliation needs to finish recording a completed creation or safely undo an
// incomplete one; see taskWorktreeCreateJournalPath below.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    createWorktreeForGroup, releaseTaskWorktreeLease, resolveTaskWorktreeConventionDirectory,
    taskWorktreeLeasePath,
} from "../prepareTasks.ts";
import { removeWorktreeAndBranch } from "../mergeTaskWorktrees.ts";
import { writeJsonAtomically } from "../taskStateLock.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import type { TaskGroup } from "../taskGroups.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export function taskBranchName(taskNumber: number): string {
    return `task-${taskNumber}`;
}

export type CreateTaskWorktreeOutput = { worktree: string; branch: string };

// The durable F11 receipt. Written before the git worktree is created, deleted once
// task.run.worktree/leaseRunId is either recorded or fully rolled back. If it survives, Phase 8
// reconciliation should: read the physical lease at taskWorktreeLeasePath(worktreePath); if it
// still names journal.runId AND task.run.worktree/leaseRunId for journal.taskNumber already
// match journal.worktreePath/runId, the creation completed after all and the journal is stale
// (delete it); otherwise the creation never finished — remove the worktree/branch at
// journal.worktreePath and release its lease with journal.runId, then delete the journal. Never
// touch a worktree/lease at the conventional path whose lease does not name journal.runId — the
// conventional path alone never proves ownership.
export type TaskWorktreeCreateJournal = {
    taskNumber: number;
    runId: string;
    worktreePath: string;
    branch: string;
    createdAt: string;
};

export function taskWorktreeCreateJournalPath(worktreePath: string): string {
    return `${worktreePath}.create-journal.json`;
}

// Test-only fault injection, unset in production: forces the rollback's own lease release to
// fail (a live sibling holds the lease) so tests can exercise the "rollback also failed" path.
// See tests/tackle-tasks/createTaskWorktree.test.ts.
const ROLLBACK_CORRUPT_LEASE_ENV = "CREATETASKWORKTREE_TEST_CORRUPT_LEASE_BEFORE_ROLLBACK";
function corruptLeaseForTest(worktreePath: string): void {
    if (process.env[ROLLBACK_CORRUPT_LEASE_ENV] !== "1") return;
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "test-rollback-saboteur", pid: 1, createdAt: 1 }));
}

export function createTaskWorktree(taskNumber: number, runId: string, projectRoot: string): CreateTaskWorktreeOutput {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    const group: TaskGroup = {
        groupId: taskNumber,
        taskNumbers: [taskNumber],
        filePaths: Array.isArray(task.files) ? (task.files as string[]) : [],
        scope: "declared",
    };
    const branch = taskBranchName(taskNumber);
    const expectedWorktreePath = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktreePath);
    const journal: TaskWorktreeCreateJournal = {
        taskNumber, runId, worktreePath: expectedWorktreePath, branch, createdAt: getLocalIsoTimestamp(),
    };
    mkdirSync(dirname(journalPath), { recursive: true });
    writeJsonAtomically(journalPath, journal);

    const worktree = createWorktreeForGroup(projectRoot, group, runId);

    try {
        updateCurrentTaskRun(taskNumber, runId, { worktree, leaseRunId: runId }, projectRoot);
    } catch (recordError) {
        const rollbackErrors: Error[] = [];
        corruptLeaseForTest(worktree);
        try {
            releaseTaskWorktreeLease({ worktreePath: worktree, runId });
        } catch (releaseError) {
            rollbackErrors.push(releaseError instanceof Error ? releaseError : new Error(String(releaseError)));
        }
        try {
            removeWorktreeAndBranch(projectRoot, worktree, branch);
        } catch (removeError) {
            rollbackErrors.push(removeError instanceof Error ? removeError : new Error(String(removeError)));
        }
        if (rollbackErrors.length > 0) {
            throw new AggregateError(
                [recordError, ...rollbackErrors],
                `createTaskWorktree failed to record task ${taskNumber}'s worktree and rollback also failed; `
                + `recovery journal retained at "${journalPath}"`,
            );
        }
        unlinkSync(journalPath);
        throw recordError;
    }

    unlinkSync(journalPath);
    configureGeneratedArtifactIsolation(taskNumber, worktree);
    return { worktree, branch };
}

export type CreateTaskWorktreeCliInput = { taskNumber: number; runId: string; projectRoot: string };

if (process.argv[1]?.endsWith("createTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CreateTaskWorktreeCliInput;
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const output = createTaskWorktree(input.taskNumber, input.runId, projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
