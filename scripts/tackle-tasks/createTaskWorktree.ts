// "create a worktree" — plans/tackle-tasks-v1_5-plan.md Phase 3.
//
// F11: createWorktreeForGroup creates the real git worktree and takes its lease before this
// function can record task.run.worktree/leaseRunId. If that recording write fails, the
// conventional path would otherwise hold an unrecorded worktree and lease that
// doesTaskWorktreeExist can never see (it only trusts task state) and that nothing would
// ever release. So: journal the create intent first, before either the worktree creation or
// the state recording. On failure of either, roll back under the lease guard: re-read the
// physical owner, and only if it is still this runId (or already gone) remove the worktree
// and branch, release the lease last, then delete the journal. A different live owner is
// never touched — the worktree, branch and journal are all left exactly as found, and the
// mismatch is reported. If the destructive rollback itself fails, the journal is left in
// place — its shape is the exact receipt Phase 8 reconciliation needs to finish recording a
// completed creation or safely undo an incomplete one; see taskWorktreeCreateJournalPath below.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    createWorktreeForGroup, readTaskWorktreeLeaseOwner, resolveTaskWorktreeConventionDirectory,
    taskWorktreeLeasePath, withTaskWorktreeLeaseGuard,
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

// Test-only fault injection, unset in production: forces the physical lease to a different
// owner just before rollback re-reads it, so tests can exercise the "another owner holds it
// now" refusal. See tests/tackle-tasks/createTaskWorktree.test.ts.
const ROLLBACK_CORRUPT_LEASE_ENV = "CREATETASKWORKTREE_TEST_CORRUPT_LEASE_BEFORE_ROLLBACK";
function corruptLeaseForTest(worktreePath: string): void {
    if (process.env[ROLLBACK_CORRUPT_LEASE_ENV] !== "1") return;
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "test-rollback-saboteur", pid: 1, createdAt: 1 }));
}

// Test-only fault injection, unset in production: forces the rollback's own worktree/branch
// removal to fail, so tests can exercise the "removal failed, lease retained" path.
const ROLLBACK_FORCE_REMOVAL_FAILURE_ENV = "CREATETASKWORKTREE_TEST_FORCE_REMOVAL_FAILURE";
function forceRemovalFailureForTest(): void {
    if (process.env[ROLLBACK_FORCE_REMOVAL_FAILURE_ENV] !== "1") return;
    throw new Error("test-forced worktree removal failure");
}

// F11: ownership-checked, destructive-last rollback. Re-reads the physical lease under the
// lease guard and only removes the worktree/branch (and releases the lease, last) if that
// owner is still this run or already gone. A different live owner is never touched. The
// journal is deleted only once both the worktree/branch and the lease are gone; otherwise it
// is retained with enough data for Phase 8 reconciliation to finish the job.
function rollbackCreateTaskWorktree(
    projectRoot: string,
    journal: TaskWorktreeCreateJournal,
    journalPath: string,
    originalError: unknown,
): never {
    corruptLeaseForTest(journal.worktreePath);
    const leasePath = taskWorktreeLeasePath(journal.worktreePath);
    let mismatchOwnerRunId: string | undefined;
    let removalError: Error | undefined;

    withTaskWorktreeLeaseGuard(journal.worktreePath, () => {
        const owner = readTaskWorktreeLeaseOwner(leasePath);
        if (owner !== null && owner.runId !== journal.runId) {
            mismatchOwnerRunId = owner.runId;
            return;
        }
        try {
            forceRemovalFailureForTest();
            removeWorktreeAndBranch(projectRoot, journal.worktreePath, journal.branch);
        } catch (error) {
            removalError = error instanceof Error ? error : new Error(String(error));
            return;
        }
        if (owner !== null) unlinkSync(leasePath);
        unlinkSync(journalPath);
    });

    const originalErr = originalError instanceof Error ? originalError : new Error(String(originalError));
    if (mismatchOwnerRunId !== undefined) {
        throw new AggregateError(
            [originalErr],
            `createTaskWorktree rollback refused: worktree lease at "${leasePath}" is now held by run `
            + `"${mismatchOwnerRunId}", not "${journal.runId}"; journal retained at "${journalPath}"`,
        );
    }
    if (removalError !== undefined) {
        throw new AggregateError(
            [originalErr, removalError],
            `createTaskWorktree failed to record task ${journal.taskNumber}'s worktree and rollback also failed; `
            + `recovery journal retained at "${journalPath}"`,
        );
    }
    throw originalErr;
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

    let worktree: string;
    try {
        worktree = createWorktreeForGroup(projectRoot, group, runId);
        updateCurrentTaskRun(taskNumber, runId, { worktree, leaseRunId: runId }, projectRoot);
    } catch (originalError) {
        rollbackCreateTaskWorktree(projectRoot, journal, journalPath, originalError);
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
