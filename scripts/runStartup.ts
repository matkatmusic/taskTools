// Startup entry point: read-only discovery, then a gated mutating-preparation phase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";

export type DiscoveryResult = {
    openTasks: TaskRecord[];
    blockedTaskNumbers: number[];
    unblockedTaskNumbers: number[];
};

function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
    return blockedBy.map((entry) => entry.taskNum).filter((n) => openNumbers.has(n));
}

// Read-only: reads tasks.json only. No fs writes, no git, no worktree/branch creation.
export function discoverStartupState(cwd: string = process.cwd()): DiscoveryResult {
    const pair = resolveTaskFiles(cwd);
    const openTasks = readTaskFile(pair.tasksPath);
    const openNumbers = new Set(openTasks.map((t) => t.taskNumber));
    const blockedTaskNumbers: number[] = [];
    const unblockedTaskNumbers: number[] = [];
    for (const task of openTasks) {
        const bucket = openBlockersOf(task, openNumbers).length > 0 ? blockedTaskNumbers : unblockedTaskNumbers;
        bucket.push(task.taskNumber);
    }
    return { openTasks, blockedTaskNumbers, unblockedTaskNumbers };
}

export type HookCheckResult = { enabled: boolean; reason?: string };

type HookCommand = { command?: string; enabled?: boolean };
type HookEntry = { hooks?: HookCommand[] };
type HooksFile = { hooks?: Record<string, HookEntry[]> };

const RELATED_TESTS_ENTRY_POINT = "scripts/relatedTests.ts";

// Confirms the copied taskTools test hook is registered in hooks/hooks.json (never any settings.json) and not disabled.
export function confirmTestHookEnabled(
    hooksJsonPath: string = join(process.cwd(), "hooks", "hooks.json"),
): HookCheckResult {
    let parsed: HooksFile;
    try {
        parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
    } catch {
        return { enabled: false, reason: `hooks/hooks.json not found or unreadable at ${hooksJsonPath}` };
    }
    const match = Object.values(parsed.hooks ?? {})
        .flat()
        .flatMap((entry) => entry.hooks ?? [])
        .find((hook) => hook.command?.includes(RELATED_TESTS_ENTRY_POINT));
    if (!match) {
        return { enabled: false, reason: `${RELATED_TESTS_ENTRY_POINT} is not registered in hooks/hooks.json` };
    }
    if (match.enabled === false) {
        return { enabled: false, reason: `${RELATED_TESTS_ENTRY_POINT} is registered but disabled` };
    }
    return { enabled: true };
}

export type MutatingStep = () => void;
export type MutatingPreparationResult = { stopped: boolean; reason?: string; stepsRun: number };

// Gate precedes every step individually, not just the first.
export function runGatedMutatingSteps(
    steps: MutatingStep[],
    confirmHook: () => HookCheckResult = confirmTestHookEnabled,
): MutatingPreparationResult {
    let stepsRun = 0;
    for (const step of steps) {
        const check = confirmHook();
        if (!check.enabled) return { stopped: true, reason: check.reason, stepsRun };
        step();
        stepsRun++;
    }
    return { stopped: false, stepsRun };
}

export type RunStartupOptions = {
    cwd?: string;
    mutatingSteps?: MutatingStep[];
    confirmHook?: () => HookCheckResult;
};

export type RunStartupResult = {
    discovery: DiscoveryResult;
    stopped: boolean;
    reason?: string;
    stepsRun: number;
};

// Discovery never calls confirmHook or a step; mutating steps are owned elsewhere, gated here.
export function runStartup(options: RunStartupOptions = {}): RunStartupResult {
    const discovery = discoverStartupState(options.cwd);
    const { stopped, reason, stepsRun } = runGatedMutatingSteps(options.mutatingSteps ?? [], options.confirmHook);
    return { discovery, stopped, reason, stepsRun };
}
