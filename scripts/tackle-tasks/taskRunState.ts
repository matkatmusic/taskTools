// The only module that reads or writes task.run. No CLI — see plans/tackle-tasks-v1_5-plan.md §1a.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
import { readTaskWorktreeLeaseOwner, withTaskWorktreeLeaseGuard } from "../prepareTasks.ts";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "../taskFiles.ts";

export type TaskExitType =
    | "completed" | "invalid-number" | "not-open" | "already-active" | "blocked"
    | "plan-scrapped" | "tests-red" | "tests-flagged" | "suite-red"
    | "rebase-stuck" | "merge-failed" | "fence-violation" | "run-failed";

export type TaskCommit = { occurrenceId: string; hash: string; kind: "work" | "repair" | "merge" };

export type TaskTestResult = {
    stepId: string;
    testFiles: string[];
    createdTestFiles: string[];
    deletedTestFiles: string[];
    missingTests: boolean;
    passed: boolean;
    output: string;
    checkedAt: string;
};

// The tip each source occurrence sat at when the rebase finished. The merge box compares
// against it, so a clean commit landing on the source while the lock is held cannot slip in.
export type SourceTipReceipt = { occurrenceId: string; baseBranch: string; sourceTip: string };

export type FullSuiteResult = {
    stepId: string;
    layers: { occurrenceId: string; passed: boolean }[];
    passed: boolean;
    output: string;
    checkedAt: string;
};

export type TaskRunRecord = {
    runId: string;
    startedAt: string;
    endedAt: string | null;
    exitType: TaskExitType | null;
    exitNote: string | null;
    modifiedFiles: string[];
    commits: TaskCommit[];
    implementationNotesFile: string | null;
    taskTests: TaskTestResult | null;
    fullSuite: FullSuiteResult | null;
    sourceTipsAtRebase?: SourceTipReceipt[];
};

export type TaskRunState = {
    active: boolean;
    worktree: string | null;
    leaseRunId: string | null;
    history: TaskRunRecord[];
};

export type ClaimOutcome =
    | { status: "claimed"; state: TaskRunState }
    | { status: "refused"; heldByRunId: string | null }
    | { status: "closing" }
    | { status: "not-found" };

type TaskRecordWithRun = TaskRecord & { run?: TaskRunState };

function getRunState(task: TaskRecordWithRun): TaskRunState {
    return task.run ?? { active: false, worktree: null, leaseRunId: null, history: [] };
}

function findTask(tasks: TaskRecordWithRun[], taskNumber: number): TaskRecordWithRun | undefined {
    return tasks.find((candidate) => candidate.taskNumber === taskNumber);
}

function taskWorktreeLeasePath(worktreePath: string): string {
    return `${worktreePath}.lease`;
}

function taskWorktreeLeaseAdoptIntentPath(worktreePath: string): string {
    return `${worktreePath}.lease.adopt-intent`;
}

function writeFileAtomically(path: string, contents: string): void {
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
}

type WorktreeLeaseAdoptionIntent = {
    taskNumber: number;
    worktreePath: string;
    oldLeaseBytes: string;
    oldLeaseOwner: string;
    newOwnerRunId: string;
};

// Test-only fault injection, unset in production. See tests/tackle-tasks/taskRunState.test.ts.
const ADOPT_KILL_AFTER_ENV = "TASKRUNSTATE_TEST_ADOPT_KILL_AFTER";
const ADOPT_FAIL_AT_ENV = "TASKRUNSTATE_TEST_ADOPT_FAIL_AT";

function killSelfForTest(step: "intent" | "lease" | "state"): void {
    if (process.env[ADOPT_KILL_AFTER_ENV] === step) process.kill(process.pid, "SIGKILL");
}

function failForTest(step: "lease" | "state"): void {
    if (process.env[ADOPT_FAIL_AT_ENV] === step) throw new Error(`injected ${step} write failure`);
}

function readAdoptionIntent(worktreePath: string): WorktreeLeaseAdoptionIntent | null {
    try {
        return JSON.parse(readFileSync(taskWorktreeLeaseAdoptIntentPath(worktreePath), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

// Runs under both guards, at the top of every lease mutation. A retained intent means a
// prior adoption died between writing the journal and deleting it: finish it if the new
// run is still the active claimant and the old run has ended, otherwise restore the old
// lease. Either way the intent is gone by the time this returns.
function reconcileRetainedAdoptionIntent(worktreePath: string, projectRoot: string): void {
    const intent = readAdoptionIntent(worktreePath);
    if (intent === null) return;

    const { tasksPath } = resolveTaskFiles(projectRoot);
    const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
    const task = findTask(tasks, intent.taskNumber);
    const state = task === undefined ? undefined : getRunState(task);
    const activeNewest = state?.active ? state.history[state.history.length - 1] : undefined;
    const oldRun = state?.history.find((candidate) => candidate.runId === intent.oldLeaseOwner);
    const shouldFinish = activeNewest?.runId === intent.newOwnerRunId
        && oldRun !== undefined && oldRun.endedAt !== null;

    if (shouldFinish) {
        writeJsonAtomically(
            taskWorktreeLeasePath(worktreePath),
            { runId: intent.newOwnerRunId, pid: process.pid, createdAt: Date.now() },
        );
        if (task !== undefined && state !== undefined && state.leaseRunId !== intent.newOwnerRunId) {
            task.run = { ...state, leaseRunId: intent.newOwnerRunId };
            writeJsonAtomically(tasksPath, tasks);
        }
    } else {
        writeFileAtomically(taskWorktreeLeasePath(worktreePath), intent.oldLeaseBytes);
    }
    unlinkSync(taskWorktreeLeaseAdoptIntentPath(worktreePath));
}

export function getLocalIsoTimestamp(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const offsetMinutes = -now.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
    const offsetMins = pad(Math.abs(offsetMinutes) % 60);
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
        + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
        + `${sign}${offsetHours}:${offsetMins}`;
}

export function readTaskRunState(taskNumber: number, projectRoot: string): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
    const task = findTask(tasks, taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    return getRunState(task);
}

export function getCurrentTaskRun(taskNumber: number, projectRoot: string): TaskRunRecord | null {
    const state = readTaskRunState(taskNumber, projectRoot);
    if (!state.active) return null;
    return state.history[state.history.length - 1] ?? null;
}

export function getPreviousTaskRuns(taskNumber: number, projectRoot: string): TaskRunRecord[] {
    const state = readTaskRunState(taskNumber, projectRoot);
    return state.active ? state.history.slice(0, -1) : state.history.slice();
}

export function claimTask(taskNumber: number, runId: string, projectRoot: string): ClaimOutcome {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) return { status: "not-found" };
        const current = getRunState(task);
        if (current.active) {
            const held = current.history[current.history.length - 1] ?? null;
            return { status: "refused", heldByRunId: held?.runId ?? null };
        }
        // Rule 12: inactive is not the same as claimable. A run that exited
        // completed leaves the task closing until its archive lands.
        const newest = current.history[current.history.length - 1];
        if (newest !== undefined && newest.endedAt !== null && newest.exitType === "completed") {
            return { status: "closing" };
        }
        const record: TaskRunRecord = {
            runId, startedAt: getLocalIsoTimestamp(), endedAt: null, exitType: null,
            exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
            taskTests: null, fullSuite: null,
        };
        const state: TaskRunState = { ...current, active: true, history: [...current.history, record] };
        task.run = state;
        writeJsonAtomically(tasksPath, tasks);
        return { status: "claimed", state };
    });
}

// Lock order: task-state lock outermost, worktree-lease guard innermost. Every path here —
// and the reconciliation it runs first — takes them in that order; never the reverse.
export function adoptWorktreeLease(taskNumber: number, runId: string, projectRoot: string): { adopted: boolean } {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const precheckTasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const precheckTask = findTask(precheckTasks, taskNumber);
        const worktreePath = precheckTask === undefined ? null : getRunState(precheckTask).worktree;
        if (worktreePath === null) return { adopted: false };

        return withTaskWorktreeLeaseGuard(worktreePath, () => {
            reconcileRetainedAdoptionIntent(worktreePath, projectRoot);

            const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
            const task = findTask(tasks, taskNumber);
            if (task === undefined) return { adopted: false };
            const state = getRunState(task);

            // Step 1: the active newest run is exactly this run.
            const currentRun = state.active ? state.history[state.history.length - 1] : undefined;
            if (currentRun === undefined || currentRun.runId !== runId) return { adopted: false };
            // Step 2: leaseRunId names an ended prior run.
            if (state.worktree === null || state.leaseRunId === null) return { adopted: false };
            const owningRun = state.history.find((candidate) => candidate.runId === state.leaseRunId);
            if (owningRun === undefined || owningRun.endedAt === null) return { adopted: false };

            const leasePath = taskWorktreeLeasePath(worktreePath);
            // Step 3: the sibling lease must exist, parse, and name the expected stale owner.
            let oldLeaseBytes: string;
            try {
                oldLeaseBytes = readFileSync(leasePath, "utf8");
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return { adopted: false };
                throw error;
            }
            let oldLeaseOwner: { runId?: string } | null;
            try {
                oldLeaseOwner = JSON.parse(oldLeaseBytes);
            } catch {
                return { adopted: false };
            }
            if (oldLeaseOwner === null || oldLeaseOwner.runId !== state.leaseRunId) return { adopted: false };

            const intent: WorktreeLeaseAdoptionIntent = {
                taskNumber, worktreePath, oldLeaseBytes, oldLeaseOwner: state.leaseRunId, newOwnerRunId: runId,
            };

            try {
                // Step 4: journal the intent before touching either authority.
                writeJsonAtomically(taskWorktreeLeaseAdoptIntentPath(worktreePath), intent);
                killSelfForTest("intent");
                // Step 5: replace the lease with the new owner.
                failForTest("lease");
                writeJsonAtomically(leasePath, { runId, pid: process.pid, createdAt: Date.now() });
                killSelfForTest("lease");
                // Step 6: update tasks.json to match.
                failForTest("state");
                const nextState: TaskRunState = { ...state, leaseRunId: runId };
                task.run = nextState;
                writeJsonAtomically(tasksPath, tasks);
                killSelfForTest("state");
                // Step 7: the intent is now redundant.
                unlinkSync(taskWorktreeLeaseAdoptIntentPath(worktreePath));
                return { adopted: true };
            } catch (writeError) {
                try {
                    writeFileAtomically(leasePath, oldLeaseBytes);
                    unlinkSync(taskWorktreeLeaseAdoptIntentPath(worktreePath));
                } catch (restoreError) {
                    throw new AggregateError(
                        [writeError, restoreError],
                        `worktree lease adoption failed for task ${taskNumber} and restoring the old lease also failed`,
                    );
                }
                throw writeError;
            }
        });
    });
}

export type LeaseTransitionOutcome =
    | { status: "adopted" }
    | { status: "released" }
    | { status: "absent" }
    | { status: "refused-owner-mismatch"; heldByRunId: string };

// F4/F5: the single atomic replacement for "adopt, and if that fails, catch-and-release" —
// resetTaskWorktree's old dance, which swallowed an owner-mismatch throw and then deleted a
// worktree another run still legitimately held. Re-reads state inside both guards, so a
// destructive caller never decides from an unlocked snapshot.
//
// Lease policy (F5): a worktree whose lease names an ENDED run is released here, never
// silently adopted — this operation is for callers about to reset/discard the worktree, not
// resume it. Resuming still goes through adoptWorktreeLease. A physical lease that already
// names expectedRunId is treated as already-adopted (idempotent retry of a half-finished
// reset). Any other mismatch between tasks.json and the physical lease refuses and mutates
// nothing, because that disagreement means someone else has a real claim.
export function transitionWorktreeLease(
    taskNumber: number,
    expectedRunId: string,
    projectRoot: string,
): LeaseTransitionOutcome {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const precheckTasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const precheckTask = findTask(precheckTasks, taskNumber);
        const worktreePath = precheckTask === undefined ? null : getRunState(precheckTask).worktree;
        if (worktreePath === null) return { status: "absent" };

        return withTaskWorktreeLeaseGuard(worktreePath, (): LeaseTransitionOutcome => {
            reconcileRetainedAdoptionIntent(worktreePath, projectRoot);

            const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
            const task = findTask(tasks, taskNumber);
            if (task === undefined) return { status: "absent" };
            const state = getRunState(task);
            if (state.worktree === null) return { status: "absent" };

            const leasePath = taskWorktreeLeasePath(state.worktree);
            const physicalOwner = readTaskWorktreeLeaseOwner(leasePath);
            if (physicalOwner === null) return { status: "absent" };
            if (physicalOwner.runId === expectedRunId) return { status: "adopted" };
            if (state.leaseRunId !== physicalOwner.runId) {
                return { status: "refused-owner-mismatch", heldByRunId: physicalOwner.runId };
            }
            const owningRun = state.history.find((candidate) => candidate.runId === state.leaseRunId);
            if (owningRun === undefined || owningRun.endedAt === null) {
                return { status: "refused-owner-mismatch", heldByRunId: physicalOwner.runId };
            }

            unlinkSync(leasePath);
            const nextState: TaskRunState = { ...state, leaseRunId: null };
            task.run = nextState;
            writeJsonAtomically(tasksPath, tasks);
            return { status: "released" };
        });
    });
}

// F7: the other half of establishing lease ownership — a fresh acquisition rather than an
// adoption. Only succeeds when the caller's run is the newest active claimant, the task
// carries a worktree, and no lease currently exists for it. Journals tasks.json and the
// physical lease in the same guarded transition so they can never disagree.
export function acquireAbsentWorktreeLease(
    taskNumber: number,
    expectedRunId: string,
    projectRoot: string,
): { acquired: boolean } {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const precheckTasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const precheckTask = findTask(precheckTasks, taskNumber);
        const worktreePath = precheckTask === undefined ? null : getRunState(precheckTask).worktree;
        if (worktreePath === null) return { acquired: false };

        return withTaskWorktreeLeaseGuard(worktreePath, () => {
            reconcileRetainedAdoptionIntent(worktreePath, projectRoot);

            const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
            const task = findTask(tasks, taskNumber);
            if (task === undefined) return { acquired: false };
            const state = getRunState(task);
            const currentRun = state.active ? state.history[state.history.length - 1] : undefined;
            if (currentRun === undefined || currentRun.runId !== expectedRunId) return { acquired: false };
            if (state.worktree === null) return { acquired: false };

            const leasePath = taskWorktreeLeasePath(state.worktree);
            if (readTaskWorktreeLeaseOwner(leasePath) !== null) return { acquired: false };

            writeJsonAtomically(leasePath, { runId: expectedRunId, pid: process.pid, createdAt: Date.now() });
            const nextState: TaskRunState = { ...state, leaseRunId: expectedRunId };
            task.run = nextState;
            writeJsonAtomically(tasksPath, tasks);
            return { acquired: true };
        });
    });
}

// Fences a late writer against a run the workflow has already ended and replaced (rule 11):
// expectedRunId must name the newest active record, checked inside this same lock window.
export function updateCurrentTaskRun(
    taskNumber: number,
    expectedRunId: string,
    changes: Partial<TaskRunRecord> & { worktree?: string | null; leaseRunId?: string | null },
    projectRoot: string,
): TaskRunState {
    const { worktree, leaseRunId, ...recordChanges } = changes;
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        if (!state.active) throw new Error(`no active run for task ${taskNumber}`);
        const currentRecord = state.history[state.history.length - 1];
        if (currentRecord.runId !== expectedRunId) {
            throw new Error(`task ${taskNumber}'s active run is "${currentRecord.runId}", not "${expectedRunId}"`);
        }
        const nextRecord: TaskRunRecord = { ...currentRecord, ...recordChanges };
        const nextState: TaskRunState = {
            active: true,
            worktree: worktree !== undefined ? worktree : state.worktree,
            leaseRunId: leaseRunId !== undefined ? leaseRunId : state.leaseRunId,
            history: [...state.history.slice(0, -1), nextRecord],
        };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}

export function appendTaskCommits(
    taskNumber: number,
    expectedRunId: string,
    commits: TaskCommit[],
    projectRoot: string,
): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        if (!state.active) throw new Error(`no active run for task ${taskNumber}`);
        const currentRecord = state.history[state.history.length - 1];
        if (currentRecord.runId !== expectedRunId) {
            throw new Error(`task ${taskNumber}'s active run is "${currentRecord.runId}", not "${expectedRunId}"`);
        }
        const nextRecord: TaskRunRecord = { ...currentRecord, commits: [...currentRecord.commits, ...commits] };
        const nextState: TaskRunState = { ...state, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}

export function endTaskRun(taskNumber: number, expectedRunId: string, projectRoot: string): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        if (!state.active) throw new Error(`no active run for task ${taskNumber}`);
        const currentRecord = state.history[state.history.length - 1];
        if (currentRecord.runId !== expectedRunId) {
            throw new Error(`task ${taskNumber}'s active run is "${currentRecord.runId}", not "${expectedRunId}"`);
        }
        const nextRecord: TaskRunRecord = { ...currentRecord, endedAt: getLocalIsoTimestamp() };
        const nextState: TaskRunState = { ...state, active: false, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}

// Replaces the specified ended run's outcome, never "whichever run is newest" implicitly:
// expectedRunId must name that newest record, checked in the same lock window as the write.
export function replaceEndedRunOutcome(
    taskNumber: number,
    expectedRunId: string,
    exitType: TaskExitType,
    exitNote: string,
    projectRoot: string,
): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        const newest = state.history[state.history.length - 1];
        if (
            state.active || newest === undefined || newest.runId !== expectedRunId
            || newest.endedAt === null || newest.exitType !== "completed"
        ) {
            throw new Error(`task ${taskNumber} has no ended, completed run "${expectedRunId}" whose outcome can be replaced`);
        }
        const nextRecord: TaskRunRecord = { ...newest, exitType, exitNote, endedAt: getLocalIsoTimestamp() };
        const nextState: TaskRunState = { ...state, active: false, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}
