// Writes task briefs, creates one worktree per task, prints WorkflowArguments. CLI entry point at bottom.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
import { goalText, leadingTaskNumbers, readTaskFile, resolveTaskFiles, taskFilesProjectRoot, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";
import { ORIGIN_REMOTE_ABSENT, ORIGIN_REMOTE_PRESENT, WORKTREE_HOLDS_NO_RETAINED_WORK, WORKTREE_HOLDS_RETAINED_WORK } from "./resultCodes.ts";

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
    readOnlyFiles: string[];
};

export type PreparedGroup = {
    groupId: number;
    worktree: string;
    // Absent on merge-recovery groups synthesized outside prepare; those never launch a workflow.
    workflowPath?: string;
    // The archived v1.1 skill launches this one instead; never workflowPath.
    v1_1WorkflowPath?: string;
    branch: string;
    scope: TaskGroupScope;
    tasks: PreparedTask[];
};

export type WorkflowArguments = {
    repo: string;
    typecheckCommand: string;
    groups: PreparedGroup[];
    repositorySources: RepositorySource[];
};

const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";

function getOpenBlockers(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as { taskNumber: number }[]) : [];
    return blockedBy.map((entry) => entry.taskNumber).filter((number) => openNumbers.has(number));
}

// Never defaults to every open task: this creates worktrees and fans out agents.
export function selectRequestedTasks(openTasks: TaskRecord[], requestedNumbers: number[]): TaskRecord[] {
    if (requestedNumbers.length === 0) {
        throw new Error("no task numbers given; pass a JSON array with no spaces, e.g. [268,270]");
    }
    const openNumbers = new Set(openTasks.map((task) => task.taskNumber));
    const missingNumbers = requestedNumbers.filter((number) => !openNumbers.has(number));
    if (missingNumbers.length > 0) {
        throw new Error(`not open in tasks.json: ${missingNumbers.join(", ")}`);
    }
    const requestedTasks = openTasks.filter((task) => requestedNumbers.includes(task.taskNumber));
    const runnableTasks = requestedTasks.filter((task) => getOpenBlockers(task, openNumbers).length === 0);
    const undeclaredNumbers = runnableTasks.filter((task) => declaredFiles(task).length === 0).map((task) => task.taskNumber);
    if (undeclaredNumbers.length > 0) {
        const numbers = undeclaredNumbers.join(", ");
        throw new Error(
            `these tasks declare no "modifiableFiles" and cannot be planned or implemented: ${numbers}. `
            + `A task's "modifiableFiles" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
    }
    return runnableTasks;
}

// Local time to the millisecond. Two runs starting in the same millisecond would share an id.
export function generateRunId(): string {
    const now = new Date();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    return `${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export function resolveMergeScriptPath(): string {
    return join(import.meta.dirname, "..", "merge-worktree-tasks", "mergeTaskWorktrees.ts");
}

// The merge script reads its bulky arguments from here so no agent has to retype them.
export function resolveRunArgumentsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-arguments.json");
}

// Step 6 writes the run's outcome counts and receipts here rather than shell-quoting them.
export function resolveRunOutcomesPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-outcomes.json");
}

// Step 6 drops the earlier steps' return values here verbatim; runMergePhase.ts derives the counts.
export function resolveStepOutputsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-steps.json");
}

export function resolveMergePhaseScriptPath(): string {
    return join(import.meta.dirname, "runMergePhase.ts");
}

function branchNameForGroup(groupId: number): string {
    return `task-${groupId}`;
}

export function attachOperationBranch(occurrences: RepositoryOccurrence[], branch: string): RepositoryOccurrence[] {
    return occurrences.map((occurrence) => ({ ...occurrence, operationBranch: branch }));
}

export function modifiableFiles(task: TaskRecord): string[] {
    if (Array.isArray(task.files)) {
        throw new Error(`task ${task.taskNumber}: the "files" key is no longer supported; use "modifiableFiles" and "readOnlyFiles"`);
    }
    if (Array.isArray((task as any).modifiableFiles)) return (task as any).modifiableFiles as string[];
    // return Array.isArray(task.files) ? (task.files as string[]) : []; // retired: "files" key no longer supported
    return [];
}

export function readOnlyFiles(task: TaskRecord): string[] {
    return Array.isArray((task as any).readOnlyFiles) ? (task as any).readOnlyFiles as string[] : ["*"];
}

function declaredFiles(task: TaskRecord): string[] {
    return modifiableFiles(task);
}

export function renderTaskBriefContent(task: TaskRecord, repoRoot: string): string {
    const fileSections = declaredFiles(task).map((file) => {
        const fullPath = join(repoRoot, file);
        if (!existsSync(fullPath)) return `### ${file}\n\n(missing: file not found on disk)\n`;
        if (statSync(fullPath).isDirectory()) return `### ${file}\n\n(directory, likely a submodule: see its own history)\n`;
        // const fileContent = readFileSync(fullPath, "utf8");
        // const output = `### ${file}\n\n\`\`\`\n${fileContent}\n\`\`\`\n`;
        const output = `@${file}`;
        return output;
    });
    return [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(goalText(task.chainGoal) ? [`## Chain goal\n\n${goalText(task.chainGoal)}`, ""] : []),
        ...(goalText(task.goal) ? [`## Goal\n\n**This task is considered done when all of these are true:**\n\n${goalText(task.goal)}`, ""] : []),
        ...(goalText(task.notInScope) ? [`## Not in scope\n\n${goalText(task.notInScope)}`, ""] : []),
        ...(typeof task.problemSolvedByTask === "string" && task.problemSolvedByTask.trim() !== ""
            ? [`## problemSolvedByTask\n\n${task.problemSolvedByTask}`, ""]
            : ["## problemSolvedByTask\n\n(not provided: this task was created before the problemSolvedByTask field existed)", ""]),
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        ...(typeof task.clarifyRequest === "string" && task.clarifyRequest.trim() !== ""
            ? [`## clarifyRequest\n\nA previous planning round asked this question:\n\n${task.clarifyRequest}`, ""]
            : []),
        "## Files\n",
        ...fileSections,
    ].join("\n");
}

export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    writeFileSync(briefFile, renderTaskBriefContent(task, repoRoot));
    return briefFile;
}

// The remote may lack a gitlink commit; the source checkout's submodule has it, so clone from there.
function cloneSubmodulesFromLocalCheckout(checkoutPath: string, sourcePath: string): void {
    if (!existsSync(join(checkoutPath, ".gitmodules"))) return;
    const pathEntries = execFileSync("git", ["-C", checkoutPath, "config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], { encoding: "utf8" }).trim().split("\n");
    for (const entry of pathEntries) {
        const [pathKey, submodulePath] = entry.split(" ") as [string, string];
        const name = pathKey.slice("submodule.".length, -".path".length);
        const localSource = join(sourcePath, submodulePath);
        if (!existsSync(join(localSource, ".git"))) continue;
        execFileSync(
            "git",
            ["-C", checkoutPath, "-c", `submodule.${name}.url=${localSource}`, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--", submodulePath],
            { stdio: ["ignore", "ignore", "inherit"] },
        );
        const remoteUrl = execFileSync("git", ["-C", localSource, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
        execFileSync("git", ["-C", join(checkoutPath, submodulePath), "remote", "set-url", "origin", remoteUrl], { stdio: ["ignore", "ignore", "inherit"] });
        // A clone carries no local "staging"; branch resolution needs one before the manifest can be loaded.
        const sourceStagingTip = readStagingTip(localSource);
        if (sourceStagingTip !== null) {
            execFileSync("git", ["-C", join(checkoutPath, submodulePath), "branch", "-f", "staging", sourceStagingTip], { stdio: "ignore" });
        }
        cloneSubmodulesFromLocalCheckout(join(checkoutPath, submodulePath), localSource);
    }
}

// `git worktree add` leaves submodule directories empty; a worker needs them populated.
export function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    const sourceRoot = dirname(execFileSync("git", ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim());
    cloneSubmodulesFromLocalCheckout(worktreePath, sourceRoot);
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

export const STAGING_REF = "refs/heads/staging";

// null means the branch is absent. Any other git failure throws; status 1 is "not found".
export function readStagingTip(repoRoot: string): string | null {
    const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${STAGING_REF}^{commit}`], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
    if (result.status === 1) return null;
    throw new Error(`git rev-parse ${STAGING_REF} failed in "${repoRoot}": ${result.stderr}`);
}

// Moves local "staging" to target; if a worktree has it checked out, fast-forward there instead.
function moveStagingBranchTo(repoRoot: string, target: string): void {
    const moved = spawnSync("git", ["-C", repoRoot, "branch", "-f", "staging", target], { encoding: "utf8" });
    if (moved.status !== 0) {
        const stagingCheckout = moved.stderr.match(/used by worktree at '([^']+)'/)?.[1];
        if (stagingCheckout === undefined) {
            throw new Error(`${STAGING_REF} could not be moved to "${target}" in "${repoRoot}": ${moved.stderr.trim()}`);
        }
        execFileSync("git", ["-C", stagingCheckout, "merge", "--ff-only", target], { stdio: ["ignore", "ignore", "inherit"] });
    }
}

// RETIRED (task 8, reversed 2026-09-08): staging = HEAD + task merges; creates from HEAD, race-safe if ref exists.
export function resolveOrCreateStagingTip(repoRoot: string): string {
    const found = readStagingTip(repoRoot);
    if (found === null) {
        const created = spawnSync("git", ["-C", repoRoot, "branch", "staging"], { encoding: "utf8" });
        const foundAfterCreate = readStagingTip(repoRoot);
        if (foundAfterCreate === null) {
            throw new Error(`could not create ${STAGING_REF} in "${repoRoot}": ${created.stderr}`);
        }
        return foundAfterCreate;
    }
    const headTip = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    if (found === headTip) return found;
    const stagingIsMergedIntoHead = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", found, "HEAD"], { stdio: "ignore" });
    if (stagingIsMergedIntoHead.status === 0) {
        moveStagingBranchTo(repoRoot, headTip);
        return readStagingTip(repoRoot)!;
    }
    const headIsAncestorOfStaging = spawnSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", headTip, found], { stdio: "ignore" });
    if (headIsAncestorOfStaging.status === 0) return found;
    // Diverged: neither is an ancestor of the other; merge HEAD into staging in a throwaway detached worktree.
    const tmp = mkdtempSync(join(tmpdir(), "staging-merge-"));
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", tmp, STAGING_REF], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("git", ["-C", tmp, "merge", "--no-edit", headTip], { stdio: ["ignore", "ignore", "inherit"] });
    const mergedTip = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", tmp], { stdio: ["ignore", "ignore", "inherit"] });
    moveStagingBranchTo(repoRoot, mergedTip);
    return readStagingTip(repoRoot)!;
}

// Advances/creates staging in every repository, submodules deepest first, root last.
export function resolveOrCreateStagingTipEverywhere(repoRoot: string): Map<string, string> {
    const occurrences = loadRepositoryManifest(repoRoot, currentBranchName(repoRoot)).occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .sort((a, b) => b.depth - a.depth);
    const tips = new Map<string, string>();
    for (const occurrence of occurrences) {
        tips.set(occurrence.occurrenceId, resolveOrCreateStagingTip(join(repoRoot, occurrence.occurrenceId)));
    }
    tips.set("", resolveOrCreateStagingTip(repoRoot));
    return tips;
}

function commitHoldsRetainedWork(repoPath: string, commit: string, baseTip: string): number {
    if (commit === baseTip) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    const ancestry = spawnSync("git", ["-C", repoPath, "merge-base", "--is-ancestor", commit, baseTip], { stdio: "ignore" });
    if (ancestry.status === 0) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    return WORKTREE_HOLDS_RETAINED_WORK;
}

// A branch ref a -B reset would overwrite is safe only when absent, at the base, or behind it.
function branchRefHoldsRetainedWork(repoPath: string, branchName: string, baseTip: string): number {
    const found = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}^{commit}`], { encoding: "utf8" });
    if (found.status !== 0) return WORKTREE_HOLDS_NO_RETAINED_WORK;
    return commitHoldsRetainedWork(repoPath, found.stdout.trim(), baseTip);
}

// ponytail: two safe-side limits. Checks the submodule's current HEAD, not a moved gitlink, so it can over-refuse, never lose work. A detached-HEAD folder makes this throw instead of resetting.  createBranchInEveryRepository resets task-N in every populated submodule; each is checked against its own checked-out HEAD, just set to the gitlink by init.
function submoduleTaskBranchesHoldRetainedWork(worktreePath: string, branchName: string): number {
    for (const path of submodulePaths(worktreePath, currentBranchName(worktreePath))) {
        const submodulePath = join(worktreePath, path);
        const gitlinkTip = execFileSync("git", ["-C", submodulePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        if (branchRefHoldsRetainedWork(submodulePath, branchName, gitlinkTip) === WORKTREE_HOLDS_RETAINED_WORK) {
            return WORKTREE_HOLDS_RETAINED_WORK;
        }
    }
    return WORKTREE_HOLDS_NO_RETAINED_WORK;
}

// A two-lap failure can leave commits or edits in the worktree for inspection/recovery.
// function worktreeHoldsRetainedWork(worktreePath: string, repoRoot: string): number {
//     const status = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" });
//     if (status.trim().length > 0) return WORKTREE_HOLDS_RETAINED_WORK;
//     const worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
//     const sourceTip = execFileSync("git", ["-C", repoRoot, "rev-parse", currentBranchName(repoRoot)], { encoding: "utf8" }).trim();
//     if (worktreeHead === sourceTip) return WORKTREE_HOLDS_NO_RETAINED_WORK;
//     try {
//         execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", worktreeHead, sourceTip], { stdio: "ignore" });
//         return WORKTREE_HOLDS_NO_RETAINED_WORK;
//     } catch {
//         return WORKTREE_HOLDS_RETAINED_WORK;
//     }
// }

function worktreeHoldsRetainedWork(worktreePath: string, repoRoot: string, branchName: string, stagingTip: string): number {
    const status = execFileSync(
        "git",
        ["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        { encoding: "utf8" },
    );
    if (status.trim().length > 0) return WORKTREE_HOLDS_RETAINED_WORK;
    const worktreeHead = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (commitHoldsRetainedWork(repoRoot, worktreeHead, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
        return WORKTREE_HOLDS_RETAINED_WORK;
    }
    return branchRefHoldsRetainedWork(repoRoot, branchName, stagingTip);
}

export type TaskWorktreeLease = { worktreePath: string; runId: string };

export function taskWorktreeLeasePath(worktreePath: string): string {
    return `${worktreePath}.lease`;
}

export function readTaskWorktreeLeaseOwner(leasePath: string): { pid: number; runId: string } | null {
    try {
        return JSON.parse(readFileSync(leasePath, "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

const LEASE_GUARD_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LEASE_GUARD_TIMEOUT_MS = 10_000;

export function taskWorktreeLeaseGuardPath(worktreePath: string): string {
    return `${worktreePath}.lease.guard`;
}

// Makes one read/validate/write transition on the lease indivisible, so acquire, release and adopt never overlap.
export function withTaskWorktreeLeaseGuard<T>(worktreePath: string, action: () => T): T {
    const guardPath = taskWorktreeLeaseGuardPath(worktreePath);
    const deadline = Date.now() + LEASE_GUARD_TIMEOUT_MS;
    let fd: number | null = null;

    while (fd === null) {
        try {
            fd = openSync(guardPath, "wx", 0o600);
            writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline) {
                const holder = readTaskWorktreeLeaseOwner(guardPath);
                throw new Error(
                    `worktree lease guard timed out at "${guardPath}"`
                    + (holder ? `; held by pid ${holder.pid}` : ""),
                );
            }
            Atomics.wait(LEASE_GUARD_WAIT, 0, 0, 10);
        }
    }

    try {
        return action();
    } finally {
        closeSync(fd);
        unlinkSync(guardPath);
    }
}

// Atomic exclusive-create, held until final cleanup. runId is stable across processes; pid isn't.
export function acquireTaskWorktreeLease(worktreePath: string, runId: string): TaskWorktreeLease {
    return withTaskWorktreeLeaseGuard(worktreePath, () => {
        const leasePath = taskWorktreeLeasePath(worktreePath);
        let fd: number;
        try {
            fd = openSync(leasePath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                // The same run re-preparing an already-leased worktree is a no-op, not a conflict.
                const current = readTaskWorktreeLeaseOwner(leasePath);
                if (current !== null && current.runId === runId) return { worktreePath, runId };
                throw new Error(
                    `worktree at "${worktreePath}" is already owned by a live run (lease at "${leasePath}"); `
                    + `if that run crashed, call recoverStaleTaskWorktreeLease() after confirming no work is retained`,
                );
            }
            throw error;
        }
        writeFileSync(fd, JSON.stringify({ runId, pid: process.pid, createdAt: Date.now() }));
        closeSync(fd);
        return { worktreePath, runId };
    });
}

// Ownership-checked and idempotent: no-op if already released, refuses a lease it didn't acquire.
export function releaseTaskWorktreeLease(lease: TaskWorktreeLease): void {
    withTaskWorktreeLeaseGuard(lease.worktreePath, () => {
        const leasePath = taskWorktreeLeasePath(lease.worktreePath);
        const current = readTaskWorktreeLeaseOwner(leasePath);
        if (current === null) return;
        if (current.runId !== lease.runId) {
            throw new Error(`refusing to release worktree lease at "${leasePath}": held by run "${current.runId}", not "${lease.runId}"`);
        }
        unlinkSync(leasePath);
    });
}

// ponytail: no auto liveness probe on the pid; explicit human call only, like taskStateLock's fail-safe stance.
export function recoverStaleTaskWorktreeLease(repoRoot: string, worktreePath: string): void {
    const leasePath = taskWorktreeLeasePath(worktreePath);
    if (readTaskWorktreeLeaseOwner(leasePath) === null) return;
    if (!existsSync(worktreePath)) {
        unlinkSync(leasePath);
        return;
    }
    // if (worktreeHoldsRetainedWork(worktreePath, repoRoot) === WORKTREE_HOLDS_RETAINED_WORK) {
    //     throw new Error(`worktree at "${worktreePath}" holds retained work; resolve or remove it before releasing its stale lease`);
    // }
    const stagingTip = readStagingTip(repoRoot);
    if (stagingTip === null) {
        throw new Error(`local staging branch is missing in "${repoRoot}"; create it before releasing the stale lease at "${worktreePath}"`);
    }
    if (worktreeHoldsRetainedWork(worktreePath, repoRoot, basename(worktreePath), stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
        throw new Error(`worktree at "${worktreePath}" holds retained work; resolve or remove it before releasing its stale lease`);
    }
    unlinkSync(leasePath);
}

// Two repos sharing a basename (or two clones of one repo) would otherwise collide here.
export function resolveTaskWorktreeConventionDirectory(repoRoot: string): string {
    // realpathSync, not resolve: a child reports /private/var, so the raw string hashes differently.
    const hash = createHash("sha256").update(realpathSync(repoRoot)).digest("hex").slice(0, 8);
    return join(tmpdir(), "taskTools-wt", `${basename(repoRoot)}-${hash}`);
}

// Test-only: SIGKILLs this process after the named step, so a retry can be tested against real process death.
const CREATE_WORKTREE_FOR_GROUP_TEST_KILL_AFTER_ENV = "CREATEWORKTREEFORGROUP_TEST_KILL_AFTER";
function killSelfForTest(step: "lease" | "gitCreate" | "gitReset"): void {
    if (process.env[CREATE_WORKTREE_FOR_GROUP_TEST_KILL_AFTER_ENV] === step) process.kill(process.pid, "SIGKILL");
}

// A lease whose owner pid no longer exists (ESRCH) is recovered before acquiring; a live pid still throws.
function recoverLeaseIfOwnerIsDead(repoRoot: string, worktreePath: string): void {
    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
    if (owner === null) return;
    try {
        process.kill(owner.pid, 0);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") recoverStaleTaskWorktreeLease(repoRoot, worktreePath);
    }
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup, runId: string = generateRunId()): string {
    const worktreePath = join(resolveTaskWorktreeConventionDirectory(repoRoot), `task-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    const isFreshCut = !existsSync(worktreePath);
    let stagingTips: Map<string, string> | undefined;
    // let lease: TaskWorktreeLease;
    // if (existsSync(worktreePath)) {
    //     if (worktreeHoldsRetainedWork(worktreePath, repoRoot) === WORKTREE_HOLDS_RETAINED_WORK) {
    //         throw new Error(
    //             `worktree at "${worktreePath}" holds retained work from a previous run; `
    //             + `resolve or remove it before re-preparing task-${group.groupId}`,
    //         );
    //     }
    //     // No retained work: acquire ownership before resetting so a racing session can't share it.
    //     lease = acquireTaskWorktreeLease(worktreePath, runId);
    //     try {
    //         execFileSync(
    //             "git",
    //             ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
    //             { stdio: "ignore" },
    //         );
    //     } catch (error) {
    //         releaseTaskWorktreeLease(lease);
    //         throw error;
    //     }
    // } else {
    //     mkdirSync(dirname(worktreePath), { recursive: true });
    //     lease = acquireTaskWorktreeLease(worktreePath, runId);
    //     try {
    //         const stagingVerify = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "staging"], { stdio: "ignore" });
    //         if (stagingVerify.status !== 0) {
    //             execFileSync("git", ["-C", repoRoot, "branch", "staging"], { stdio: "ignore" });
    //         }
    //         execFileSync(
    //             "git",
    //             ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "staging"],
    //             { stdio: "ignore" },
    //         );
    //     } catch (error) {
    //         releaseTaskWorktreeLease(lease);
    //         throw error;
    //     }
    // }
    // // A submodule-init or branch-creation failure gets the same treatment: release, don't orphan.
    // try {
    //     initializeSubmodulesInWorktree(worktreePath);
    //     createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath, currentBranchName(worktreePath))], branchName);
    // } catch (error) {
    //     releaseTaskWorktreeLease(lease);
    //     throw error;
    // }
    // return worktreePath;

    let lease: TaskWorktreeLease;
    if (existsSync(worktreePath)) {
        // Lease first, then resolve: the safety decision and the reset must see the same staging commit.
        recoverLeaseIfOwnerIsDead(repoRoot, worktreePath);
        lease = acquireTaskWorktreeLease(worktreePath, runId);
        killSelfForTest("lease");
        try {
            const stagingTip = resolveOrCreateStagingTip(repoRoot);
            if (worktreeHoldsRetainedWork(worktreePath, repoRoot, branchName, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `worktree at "${worktreePath}" holds retained work from a previous run; `
                    + `resolve or remove it before re-preparing task-${group.groupId}`,
                );
            }
            if (submoduleTaskBranchesHoldRetainedWork(worktreePath, branchName) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `worktree at "${worktreePath}" holds retained work on a submodule task branch; `
                    + `resolve or remove it before re-preparing task-${group.groupId}`,
                );
            }
            execFileSync(
                "git",
                ["-C", worktreePath, "checkout", "--force", "-B", branchName, stagingTip],
                { stdio: "ignore" },
            );
            killSelfForTest("gitReset");
        } catch (error) {
            releaseTaskWorktreeLease(lease);
            throw error;
        }
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        recoverLeaseIfOwnerIsDead(repoRoot, worktreePath);
        lease = acquireTaskWorktreeLease(worktreePath, runId);
        killSelfForTest("lease");
        try {
            stagingTips = resolveOrCreateStagingTipEverywhere(repoRoot);
            const stagingTip = stagingTips.get("")!;
            if (branchRefHoldsRetainedWork(repoRoot, branchName, stagingTip) === WORKTREE_HOLDS_RETAINED_WORK) {
                throw new Error(
                    `branch "${branchName}" holds retained work from a previous run; `
                    + `resolve or delete it before re-preparing task-${group.groupId}`,
                );
            }
            execFileSync(
                "git",
                ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, stagingTip],
                { stdio: "ignore" },
            );
            killSelfForTest("gitCreate");
        } catch (error) {
            releaseTaskWorktreeLease(lease);
            throw error;
        }
    }
    // A submodule-init or branch-creation failure gets the same treatment: release, don't orphan.
    try {
        initializeSubmodulesInWorktree(worktreePath);
        if (submoduleTaskBranchesHoldRetainedWork(worktreePath, branchName) === WORKTREE_HOLDS_RETAINED_WORK) {
            throw new Error(
                `worktree at "${worktreePath}" holds retained work on a submodule task branch; `
                + `resolve or remove it before re-preparing task-${group.groupId}`,
            );
        }
        if (isFreshCut) {
            // Fresh cut only: submodule task-N comes from that submodule's own staging tip, not the gitlink.
            for (const [occurrenceId, tip] of stagingTips!) {
                if (occurrenceId === "") continue;
                const submoduleWorktreePath = join(worktreePath, occurrenceId);
                const sourceSubmodulePath = join(repoRoot, occurrenceId);
                execFileSync("git", ["-C", submoduleWorktreePath, "fetch", sourceSubmodulePath, tip], { stdio: ["ignore", "ignore", "inherit"] });
                execFileSync("git", ["-C", submoduleWorktreePath, "checkout", "-B", branchName, "FETCH_HEAD"], { stdio: ["ignore", "ignore", "inherit"] });
                execFileSync("git", ["-C", sourceSubmodulePath, "update-ref", `refs/taskTools/reset-point/${branchName}`, tip], { stdio: ["ignore", "ignore", "inherit"] });
                execFileSync("git", ["-C", sourceSubmodulePath, "branch", "-f", branchName, tip], { stdio: ["ignore", "ignore", "inherit"] });
            }
            execFileSync("git", ["-C", repoRoot, "update-ref", `refs/taskTools/reset-point/${branchName}`, stagingTips!.get("")!], { stdio: ["ignore", "ignore", "inherit"] });
            createBranchInEveryRepository(worktreePath, [""], branchName);
        } else {
            createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath, currentBranchName(worktreePath))], branchName);
        }
    } catch (error) {
        releaseTaskWorktreeLease(lease);
        throw error;
    }
    return worktreePath;
}

// A later task's setup failure must not strand leases acquired for earlier tasks in the same batch.
function rollbackPreparedGroupLeases(preparedGroups: PreparedGroup[], runId: string): Error[] {
    const rollbackErrors: Error[] = [];
    for (const group of [...preparedGroups].reverse()) {
        try {
            releaseTaskWorktreeLease({ worktreePath: group.worktree, runId });
        } catch (error) {
            rollbackErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    return rollbackErrors;
}

function rethrowAfterPreparedLeaseRollback(error: unknown, preparedGroups: PreparedGroup[], runId: string): never {
    const rollbackErrors = rollbackPreparedGroupLeases(preparedGroups, runId);
    if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], "task preparation failed and one or more acquired leases could not be released");
    }
    throw error;
}

export const CURRENT_WORKFLOW_TEMPLATE_PATH = fileURLToPath(new URL("../../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));
export const V1_1_WORKFLOW_TEMPLATE_PATH = fileURLToPath(new URL("../../skills/tackle-tasks-v1_1/tackle-tasks.workflow.js", import.meta.url));

export function currentWorkflowOutputPath(worktreePath: string): string {
    return `${worktreePath}.tackle-tasks.workflow.js`;
}

export function v1_1WorkflowOutputPath(worktreePath: string): string {
    return `${worktreePath}.tackle-tasks-v1_1.workflow.js`;
}

// Harness needs a literal `meta` first statement, so bake in the task number. templatePath stays explicit, no hidden default.
export function materializeTaskWorkflow(taskNumber: number, templatePath: string, outputPath: string): string {
    writeFileSync(outputPath, readFileSync(templatePath, "utf8").replaceAll("__TT_TASK__", String(taskNumber)));
    return outputPath;
}

export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    tasks: TaskRecord[],
    runId: string = generateRunId(),
): WorkflowArguments {
    // const stagingVerify = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "staging"], { stdio: "ignore" });
    // if (stagingVerify.status !== 0) {
    //     execFileSync("git", ["-C", repoRoot, "branch", "staging"], { stdio: "ignore" });
    // }
    resolveOrCreateStagingTipEverywhere(repoRoot);
    const repositorySources = collectRepositorySources(repoRoot, "staging");
    const preparedGroups: PreparedGroup[] = [];
    try {
        for (const task of tasks) {
            const group: TaskGroup = {
                groupId: task.taskNumber,
                taskNumbers: [task.taskNumber],
                filePaths: declaredFiles(task),
                scope: "declared",
            };
            const worktree = createWorktreeForGroup(repoRoot, group, runId);
            const workflowPath = currentWorkflowOutputPath(worktree);
            const v1_1WorkflowPath = v1_1WorkflowOutputPath(worktree);
            try {
                materializeTaskWorkflow(task.taskNumber, CURRENT_WORKFLOW_TEMPLATE_PATH, workflowPath);
                materializeTaskWorkflow(task.taskNumber, V1_1_WORKFLOW_TEMPLATE_PATH, v1_1WorkflowPath);
            } catch (error) {
                for (const path of [workflowPath, v1_1WorkflowPath]) {
                    if (existsSync(path)) unlinkSync(path);
                }
                releaseTaskWorktreeLease({ worktreePath: worktree, runId });
                throw error;
            }
            preparedGroups.push({
                groupId: group.groupId,
                worktree,
                workflowPath,
                v1_1WorkflowPath,
                branch: branchNameForGroup(group.groupId),
                scope: group.scope,
                tasks: [{
                    number: task.taskNumber,
                    briefFile: join(worktree, "plans", `brief-${task.taskNumber}.md`),
                    planFile: join(worktree, "plans", `task-${task.taskNumber}-plan.md`),
                    files: declaredFiles(task),
                    readOnlyFiles: readOnlyFiles(task),
                }],
            });
        }
        return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
    } catch (error) {
        rethrowAfterPreparedLeaseRollback(error, preparedGroups, runId);
    }
}

export function loadRepositoryManifest(repoRoot: string, rootBranch: string): RepositoryManifest {
    const result = bootstrapRepositoryManifest(repoRoot, rootBranch);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function hasOriginRemote(repoRoot: string): number {
    try {
        execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { stdio: "ignore" });
        return ORIGIN_REMOTE_PRESENT;
    } catch {
        return ORIGIN_REMOTE_ABSENT;
    }
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        if (hasOriginRemote(repoRoot) !== ORIGIN_REMOTE_PRESENT) {
            throw new Error("this repository does not have an origin remote. set one to continue to use 'tackle-tasks'");
        }
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
        // retired: the new pipeline never runs this CLI; the missing-file check lives in preparedTask.ts loadPreparedTask.
        // for (const task of tasks) {
        //     const createsFiles = Array.isArray(task.createsFiles) ? (task.createsFiles as string[]) : [];
        //     const missing = modifiableFiles(task).filter((file) => !createsFiles.includes(file) && !existsSync(join(repoRoot, file)));
        //     if (missing.length > 0) {
        //         throw new Error(
        //             `task ${task.taskNumber} names files that do not exist on disk: ${missing.join(", ")}. `
        //             + `List each new file the task creates in its "createsFiles" array, or run the task that creates it first.`,
        //         );
        //     }
        // }
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
    const runId = generateRunId();
    let workflowArguments: WorkflowArguments | null = null;
    let ownershipTransferred = false;
    try {
        // const stagingVerify = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", "staging"], { stdio: "ignore" });
        // if (stagingVerify.status !== 0) {
        //     execFileSync("git", ["-C", repoRoot, "branch", "staging"], { stdio: "ignore" });
        // }
        resolveOrCreateStagingTipEverywhere(repoRoot);
        const manifest = loadRepositoryManifest(repoRoot, "staging");
        workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks, runId);
        // startTimestamp is stamped here because workflow scripts cannot call Date.now().
        const pipelineArguments = {
            ...workflowArguments,
            runId,
            startTimestamp: new Date().toISOString(),
            mergeScript: resolveMergeScriptPath(),
            repositoryManifest: manifest,
        };
        const argumentsFile = resolveRunArgumentsPath(taskFilesProjectRoot(pair));
        mkdirSync(dirname(argumentsFile), { recursive: true });
        withTaskStateLock(pair.tasksPath, () => {
            const latestByNumber = new Map(readTaskFile(pair.tasksPath).map((task) => [task.taskNumber, task]));
            for (const group of pipelineArguments.groups) {
                for (const preparedTask of group.tasks) {
                    const latest = latestByNumber.get(preparedTask.number);
                    if (!latest) {
                        throw new Error(`prepareTasks: task ${preparedTask.number} changed or closed during preparation`);
                    }
                    preparedTask.files = declaredFiles(latest);
                    preparedTask.readOnlyFiles = readOnlyFiles(latest);
                }
            }
            writeJsonAtomically(argumentsFile, pipelineArguments);
        });
        process.stdout.write(JSON.stringify({
            ...pipelineArguments,
            stepOutputsFile: resolveStepOutputsPath(repoRoot),
            mergeCommand: `node "${resolveMergePhaseScriptPath()}"`,
        }));
        ownershipTransferred = true;
    } catch (error) {
        // buildWorkflowArguments already unwinds its own partial batch when it throws.
        if (workflowArguments !== null && !ownershipTransferred) {
            rethrowAfterPreparedLeaseRollback(error, workflowArguments.groups, runId);
        }
        throw error;
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
