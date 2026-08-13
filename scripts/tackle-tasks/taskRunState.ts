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

// F2: `stepId` names the logical commit step that created this commit. Merge-kind commits
// (mergeTaskWorktree.ts, recordMergeCommits.ts) do not carry one — optional so those untouched
// producers keep compiling. commitTaskWork.ts always sets it: durable evidence a lost result can
// be scoped back to the exact step that produced it, instead of any earlier visit's commits.
export type TaskCommit = { occurrenceId: string; hash: string; kind: "work" | "repair" | "merge"; stepId?: string };

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

// F3: visit-specific durable evidence for the rebase/advance boxes, separate from
// `sourceTipsAtRebase` (which mergeTaskWorktree.ts reads and must keep its existing shape).
// `stepId` fences this receipt to the exact logical step that wrote it, `occurrenceIds` is the
// exact occurrence set that step covered, and `worktreeHeads` is each layer's HEAD right after
// the step finished — enough for a read-only reconciliation to tell a stale receipt from a live
// one without ever accepting a prior visit's evidence for a later step.
export type RebaseStepReceipt = {
    stepId: string;
    occurrenceIds: string[];
    worktreeHeads: { occurrenceId: string; head: string }[];
    sourceTips: SourceTipReceipt[];
};

// F3/F10: one durable receipt per logical mutating step, written before the box's stdout, for
// every returned outcome (not just a clean/happy result). `result` is the box's exact return
// value; `occurrenceIds`/`worktreeHeads` are optional live-state evidence a validator can compare
// against the current worktree to tell a still-live receipt from a stale one. A receipt is looked
// up by `stepId` (and `script`, so two boxes sharing a run never cross-match).
export type StepResultReceipt = {
    stepId: string;
    script: string;
    result: unknown;
    occurrenceIds?: string[];
    worktreeHeads?: { occurrenceId: string; head: string }[];
};

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
    rebaseStepReceipt?: RebaseStepReceipt;
    stepResults?: StepResultReceipt[];
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

// Generalized across both ways ownership changes hands: adopting an ended run's lease
// (previousLeaseBytes set) and acquiring a wholly absent one (previousLeaseBytes null,
// meaning "no physical lease existed before this transition").
type WorktreeLeaseTransitionIntent = {
    taskNumber: number;
    worktreePath: string;
    previousLeaseBytes: string | null;
    previousStateOwner: string | null;
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

function readTransitionIntent(worktreePath: string): WorktreeLeaseTransitionIntent | null {
    try {
        return JSON.parse(readFileSync(taskWorktreeLeaseAdoptIntentPath(worktreePath), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

// Writes back exactly the physical state the intent recorded as "before": the prior lease
// bytes if one existed, or removes the file if the lease was absent beforehand.
function restoreOrRemoveLease(leasePath: string, previousLeaseBytes: string | null): void {
    if (previousLeaseBytes === null) {
        try {
            unlinkSync(leasePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return;
    }
    writeFileAtomically(leasePath, previousLeaseBytes);
}

function readLeaseBytesOrNull(leasePath: string): string | null {
    try {
        return readFileSync(leasePath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

function describeLeaseOwner(bytes: string | null): string {
    if (bytes === null) return "no lease";
    try {
        const parsed = JSON.parse(bytes) as { runId?: string };
        return parsed?.runId ?? "an unparseable lease";
    } catch {
        return "an unparseable lease";
    }
}

// The only question a retained intent's reconciliation is allowed to answer from the
// physical lease: is it still exactly where the intent left the world (or found it), or
// does it already show the new owner's partially-completed write? Anything else names a
// third run that must never be overwritten, so it is a hard mismatch, not a data point to
// weigh against tasks.json.
function isPhysicalLeaseCompatibleWithIntent(
    physicalBytes: string | null,
    intent: WorktreeLeaseTransitionIntent,
): boolean {
    if (physicalBytes === intent.previousLeaseBytes) return true;
    if (physicalBytes === null) return false;
    try {
        return (JSON.parse(physicalBytes) as { runId?: string }).runId === intent.newOwnerRunId;
    } catch {
        return false;
    }
}

// Runs under both guards, at the top of every lease mutation. A retained intent means a
// prior adoption or acquisition died between writing the journal and deleting it. Before
// changing either authority, read the physical lease that exists right now and classify it
// against the intent: only the exact recorded prior state (including absence) or the
// intent's own new owner are safe to act on. Anything else is a different run that acquired
// or was assigned the lease during the recovery window — refuse outright rather than finish
// or roll back over it. Otherwise finish if the new run is still the active claimant and the
// previous owner (if any) has ended, or roll back to the prior physical state. Either way the
// intent is gone by the time this returns.
function reconcileRetainedAdoptionIntent(worktreePath: string, projectRoot: string): void {
    const intent = readTransitionIntent(worktreePath);
    if (intent === null) return;

    const leasePath = taskWorktreeLeasePath(worktreePath);
    const physicalBytes = readLeaseBytesOrNull(leasePath);
    if (!isPhysicalLeaseCompatibleWithIntent(physicalBytes, intent)) {
        throw new Error(
            `worktree lease for task ${intent.taskNumber} at "${leasePath}" is held by `
            + `${describeLeaseOwner(physicalBytes)}, not the recorded prior owner or the `
            + `intended new owner "${intent.newOwnerRunId}"; recover the stale intent at `
            + `"${taskWorktreeLeaseAdoptIntentPath(worktreePath)}" explicitly before retrying`,
        );
    }

    const { tasksPath } = resolveTaskFiles(projectRoot);
    const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
    const task = findTask(tasks, intent.taskNumber);
    const state = task === undefined ? undefined : getRunState(task);
    const activeNewest = state?.active ? state.history[state.history.length - 1] : undefined;
    const previousOwnerRun = intent.previousStateOwner === null
        ? undefined
        : state?.history.find((candidate) => candidate.runId === intent.previousStateOwner);
    const previousOwnerClear = intent.previousStateOwner === null
        || (previousOwnerRun !== undefined && previousOwnerRun.endedAt !== null);
    const shouldFinish = activeNewest?.runId === intent.newOwnerRunId && previousOwnerClear;

    if (shouldFinish) {
        writeJsonAtomically(leasePath, { runId: intent.newOwnerRunId, pid: process.pid, createdAt: Date.now() });
        if (task !== undefined && state !== undefined && state.leaseRunId !== intent.newOwnerRunId) {
            task.run = { ...state, leaseRunId: intent.newOwnerRunId };
            writeJsonAtomically(tasksPath, tasks);
        }
    } else {
        restoreOrRemoveLease(leasePath, intent.previousLeaseBytes);
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

            const intent: WorktreeLeaseTransitionIntent = {
                taskNumber, worktreePath,
                previousLeaseBytes: oldLeaseBytes, previousStateOwner: state.leaseRunId,
                newOwnerRunId: runId,
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
                    restoreOrRemoveLease(leasePath, intent.previousLeaseBytes);
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
// carries a worktree, and no lease currently exists for it. Journals the transition intent
// before either authority changes, then the physical lease, then tasks.json — the same
// order and the same reconciliation as adoptWorktreeLease, so a death between the two
// durable writes is always recoverable instead of stranding the worktree as
// permanently non-resumable.
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
            const existingOwner = readTaskWorktreeLeaseOwner(leasePath);
            if (existingOwner !== null) {
                // Idempotent retry: reconciliation above may have just finished this exact
                // acquisition. Only report acquired when both authorities already agree.
                return { acquired: existingOwner.runId === expectedRunId && state.leaseRunId === expectedRunId };
            }

            const intent: WorktreeLeaseTransitionIntent = {
                taskNumber, worktreePath: state.worktree,
                previousLeaseBytes: null, previousStateOwner: state.leaseRunId,
                newOwnerRunId: expectedRunId,
            };

            try {
                writeJsonAtomically(taskWorktreeLeaseAdoptIntentPath(state.worktree), intent);
                killSelfForTest("intent");
                failForTest("lease");
                writeJsonAtomically(leasePath, { runId: expectedRunId, pid: process.pid, createdAt: Date.now() });
                killSelfForTest("lease");
                failForTest("state");
                const nextState: TaskRunState = { ...state, leaseRunId: expectedRunId };
                task.run = nextState;
                writeJsonAtomically(tasksPath, tasks);
                killSelfForTest("state");
                unlinkSync(taskWorktreeLeaseAdoptIntentPath(state.worktree));
                return { acquired: true };
            } catch (writeError) {
                try {
                    restoreOrRemoveLease(leasePath, intent.previousLeaseBytes);
                    unlinkSync(taskWorktreeLeaseAdoptIntentPath(state.worktree));
                } catch (restoreError) {
                    throw new AggregateError(
                        [writeError, restoreError],
                        `worktree lease acquisition failed for task ${taskNumber} and restoring the prior lease also failed`,
                    );
                }
                throw writeError;
            }
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

// F3/F10: persists a step-result receipt onto the run named by expectedRunId, whether that run
// is still active or has already ended (releaseTaskRunHolds runs after markTaskInactive, so this
// must not require `active`). Locates the run by runId anywhere as the newest history entry —
// same fencing rule as updateCurrentTaskRun — and replaces any prior receipt for the same stepId
// rather than accumulating duplicates across retries.
export function appendStepResult(
    taskNumber: number,
    expectedRunId: string,
    entry: StepResultReceipt,
    projectRoot: string,
): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        const newest = state.history[state.history.length - 1];
        if (newest === undefined || newest.runId !== expectedRunId) {
            throw new Error(`task ${taskNumber}'s newest run is not "${expectedRunId}"`);
        }
        const stepResults = [
            ...(newest.stepResults ?? []).filter((existing) => existing.stepId !== entry.stepId || existing.script !== entry.script),
            entry,
        ];
        const nextRecord: TaskRunRecord = { ...newest, stepResults };
        const nextState: TaskRunState = { ...state, history: [...state.history.slice(0, -1), nextRecord] };
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
