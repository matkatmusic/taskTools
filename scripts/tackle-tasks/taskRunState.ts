// The only module that reads or writes task.run. No CLI — see plans/tackle-tasks-v1_5-plan.md §1a.
import { writeFileSync } from "node:fs";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";
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
    missingTests: boolean;
    passed: boolean;
    output: string;
    checkedAt: string;
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

const EMPTY_RUN_STATE: TaskRunState = { active: false, worktree: null, leaseRunId: null, history: [] };

function getRunState(task: TaskRecordWithRun): TaskRunState {
    return task.run ?? EMPTY_RUN_STATE;
}

function findTask(tasks: TaskRecordWithRun[], taskNumber: number): TaskRecordWithRun | undefined {
    return tasks.find((candidate) => candidate.taskNumber === taskNumber);
}

function taskWorktreeLeasePath(worktreePath: string): string {
    return `${worktreePath}.lease`;
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

export function adoptWorktreeLease(taskNumber: number, runId: string, projectRoot: string): { adopted: boolean } {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) return { adopted: false };
        const state = getRunState(task);
        const currentRun = state.active ? state.history[state.history.length - 1] : undefined;
        if (currentRun === undefined || currentRun.runId !== runId) return { adopted: false };
        if (state.worktree === null || state.leaseRunId === null) return { adopted: false };
        const owningRun = state.history.find((candidate) => candidate.runId === state.leaseRunId);
        if (owningRun === undefined || owningRun.endedAt === null) return { adopted: false };

        const nextState: TaskRunState = { ...state, leaseRunId: runId };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        writeFileSync(
            taskWorktreeLeasePath(state.worktree),
            JSON.stringify({ runId, pid: process.pid, createdAt: Date.now() }),
        );
        return { adopted: true };
    });
}

export function updateCurrentTaskRun(
    taskNumber: number,
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

export function appendTaskCommits(taskNumber: number, commits: TaskCommit[], projectRoot: string): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        if (!state.active) throw new Error(`no active run for task ${taskNumber}`);
        const currentRecord = state.history[state.history.length - 1];
        const nextRecord: TaskRunRecord = { ...currentRecord, commits: [...currentRecord.commits, ...commits] };
        const nextState: TaskRunState = { ...state, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}

export function endTaskRun(taskNumber: number, projectRoot: string): TaskRunState {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return withTaskStateLock(tasksPath, () => {
        const tasks = readTaskFile(tasksPath) as TaskRecordWithRun[];
        const task = findTask(tasks, taskNumber);
        if (task === undefined) throw new Error(`task ${taskNumber} not found`);
        const state = getRunState(task);
        if (!state.active) throw new Error(`no active run for task ${taskNumber}`);
        const currentRecord = state.history[state.history.length - 1];
        const nextRecord: TaskRunRecord = { ...currentRecord, endedAt: getLocalIsoTimestamp() };
        const nextState: TaskRunState = { ...state, active: false, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}

export function replaceEndedRunOutcome(
    taskNumber: number,
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
        if (newest === undefined) throw new Error(`task ${taskNumber} has no run history`);
        const nextRecord: TaskRunRecord = { ...newest, exitType, exitNote, endedAt: getLocalIsoTimestamp() };
        const nextState: TaskRunState = { ...state, active: false, history: [...state.history.slice(0, -1), nextRecord] };
        task.run = nextState;
        writeJsonAtomically(tasksPath, tasks);
        return nextState;
    });
}
