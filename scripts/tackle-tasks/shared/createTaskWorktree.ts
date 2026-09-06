// F11: journals intent before creating the worktree, so failures roll back safely and Phase 8 can recover.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    createWorktreeForGroup, modifiableFiles, readTaskWorktreeLeaseOwner, resolveTaskWorktreeConventionDirectory,
    taskWorktreeLeasePath, withTaskWorktreeLeaseGuard,
} from "../../shared/prepareTasks.ts";
import { removeWorktreeAndBranch } from "../../merge-worktree-tasks/mergeTaskWorktrees.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import type { TaskGroup } from "../../shared/taskGroups.ts";
import { configureGeneratedArtifactIsolation } from "./writeTaskBrief.ts";
import { getLocalIsoTimestamp, updateCurrentTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export function taskBranchName(taskNumber: number): string {
    return `task-${taskNumber}`;
}

export type CreateTaskWorktreeOutput = { worktree: string; branch: string };

// F11 journal: written before worktree creation, deleted once recorded or rolled back; guides Phase 8 recovery if left behind.
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

// Test-only: forces the lease to a different owner before rollback re-reads it, to test the ownership refusal path.
const ROLLBACK_CORRUPT_LEASE_ENV = "CREATETASKWORKTREE_TEST_CORRUPT_LEASE_BEFORE_ROLLBACK";
function corruptLeaseForTest(worktreePath: string): void {
    if (process.env[ROLLBACK_CORRUPT_LEASE_ENV] !== "1") return;
    writeFileSync(taskWorktreeLeasePath(worktreePath), JSON.stringify({ runId: "test-rollback-saboteur", pid: 1, createdAt: 1 }));
}

// Test-only: forces rollback's worktree/branch removal to fail, to test the removal-failed lease-retained path.
const ROLLBACK_FORCE_REMOVAL_FAILURE_ENV = "CREATETASKWORKTREE_TEST_FORCE_REMOVAL_FAILURE";
function forceRemovalFailureForTest(): void {
    if (process.env[ROLLBACK_FORCE_REMOVAL_FAILURE_ENV] !== "1") return;
    throw new Error("test-forced worktree removal failure");
}

// F11 rollback: removes worktree/lease only if still owned by this run; otherwise retains the journal for Phase 8.
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

// F1 recovery: resumes or rolls back a retained journal under the lease guard, trusting only run and lease together.
function recoverRetainedCreateJournal(
    projectRoot: string, taskNumber: number, runId: string, expectedWorktreePath: string, branch: string, journalPath: string,
): CreateTaskWorktreeOutput | null {
    let journal: TaskWorktreeCreateJournal;
    try {
        journal = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    if (journal.taskNumber !== taskNumber || journal.worktreePath !== expectedWorktreePath || journal.branch !== branch) {
        throw new Error(
            `retained creation journal at "${journalPath}" does not match task ${taskNumber}'s expected `
            + `worktree/branch; refusing to touch it or create a new worktree until it is resolved`,
        );
    }

    let recovered: CreateTaskWorktreeOutput | null = null;
    withTaskWorktreeLeaseGuard(journal.worktreePath, () => {
        const leasePath = taskWorktreeLeasePath(journal.worktreePath);
        const owner = readTaskWorktreeLeaseOwner(leasePath);
        if (owner !== null && owner.runId !== journal.runId) {
            throw new Error(
                `retained creation journal at "${journalPath}" names run "${journal.runId}", but the worktree `
                + `lease is now held by run "${owner.runId}"; refusing to touch it`,
            );
        }
        // F1: a journal owned by a different run is not this call's to finish, roll back, or destroy.
        if (journal.runId !== runId) {
            throw new Error(
                `retained creation journal at "${journalPath}" names run "${journal.runId}", not the requested `
                + `run "${runId}"; refusing to touch it`,
            );
        }

        const { tasksPath } = resolveTaskFiles(projectRoot);
        const tasks = readTaskFile(tasksPath) as { taskNumber: number; run?: { worktree: string | null; leaseRunId: string | null } }[];
        const task = tasks.find((candidate) => candidate.taskNumber === journal.taskNumber);
        const state = task?.run;
        const stateMatchesJournal = state?.worktree === journal.worktreePath && state?.leaseRunId === journal.runId;

        // Task state and the physical lease must both name this run before the creation counts as finished.
        if (stateMatchesJournal && owner !== null) {
            unlinkSync(journalPath);
            recovered = { worktree: journal.worktreePath, branch: journal.branch };
            return;
        }
        if (stateMatchesJournal && owner === null) {
            throw new Error(
                `recorded task state for task ${taskNumber} names run "${journal.runId}" for the retained `
                + `creation journal at "${journalPath}", but no physical worktree lease exists; refusing to `
                + `remove a worktree that task state still claims is leased`,
            );
        }

        removeWorktreeAndBranch(projectRoot, journal.worktreePath, journal.branch);
        if (owner !== null) unlinkSync(leasePath);
        unlinkSync(journalPath);
    });
    return recovered;
}

export function createTaskWorktree(taskNumber: number, runId: string, projectRoot: string): CreateTaskWorktreeOutput {
    const branch = taskBranchName(taskNumber);
    const expectedWorktreePath = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktreePath);

    const recovered = recoverRetainedCreateJournal(projectRoot, taskNumber, runId, expectedWorktreePath, branch, journalPath);
    if (recovered !== null) return recovered;

    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    const group: TaskGroup = {
        groupId: taskNumber,
        taskNumbers: [taskNumber],
        filePaths: modifiableFiles(task),
        scope: "declared",
    };
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

// CLI entrypoint migrated to scripts/steps/pipeline-worktreeCheck/CREATE_WORKTREE.ts and
// TAKE_WORKTREE_LEASE.ts (split into a physical-creation step and a lease-recording step).
// if (process.argv[1]?.endsWith("createTaskWorktree.ts")) {
//     const input = JSON.parse(readFileSync(0, "utf8")) as CreateTaskWorktreeCliInput;
//     const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
//     const output = createTaskWorktree(input.taskNumber, input.runId, projectRoot);
//     process.stdout.write(`${JSON.stringify(output)}\n`);
// }
