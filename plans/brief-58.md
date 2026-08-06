# Task 58: Split task file ownership into modifiableFiles and readOnlyFiles, and make briefs point at files instead of pasting them

When preparing the brief for a task, use file pointers instead of copying file contents into the brief. Add 'readOnlyFiles' to the keys of each task to provide the list of files to be read by the agent, with 'readOnlyFiles: [*]' meaning every file in the project is readable by the subagents. Change 'files' to 'modifiableFiles', meaning 'only these files are editable by the subagents'. When a task only has 'files' but not 'modifiableFiles', accept 'files'. When 'readOnlyFiles' is missing, default to '[*]' meaning all project files are readable. When close-tasks is invoked, replace 'files' with 'modifiableFiles' in the project's tasks.json.

Concretely:

1. scripts/prepareTasks.ts writeTaskBriefFile (around lines 103-120) currently inlines every declared file's full contents into plans/brief-N.md inside a fenced block. Replace those sections with a pointer list: the modifiable paths under one heading and the readable paths under another, no file bodies. Note '(missing: file not found on disk)' still applies to a declared path that does not exist.

2. Add one shared accessor pair used everywhere a task's file fence is read: modifiableFiles falls back to files when absent, and readOnlyFiles defaults to ['*']. The existing readers are scripts/prepareTasks.ts declaredFiles (line 100) and scripts/taskGroups.ts declaredFiles (line 16); both must route through it so grouping and preparation cannot diverge. Grouping and worktree-scope decisions key off modifiableFiles only — readOnlyFiles must never widen a group or make two tasks collide.

3. Thread readOnlyFiles through the prepared-task shape so the workflows can see it: the PreparedTask interface in scripts/prepareTasks.ts (line 17 files: string[]) and its construction site (line 170 files: group.filePaths), the ApprovalGate task shape in scripts/approvalGate.ts (line 12), and the flatten in scripts/mergePipeline.ts (line 141, task.files).

4. Update the four workflow prompts so the edit fence and the read fence are stated separately. Today they conflate the two: skills/tackle-tasks/plan.workflow.js line 28 says 'You may also READ these owned files, and nothing else'; implement.workflow.js lines 38 and 73; test.workflow.js lines 49, 86 and 104; verify.workflow.js line 25. Only modifiableFiles may be edited or git-added; readOnlyFiles (or the whole project when it is ['*']) may be read.

5. Update the task-authoring surfaces to emit and maintain the new keys: skills/create-task/template/taskTemplate.json, skills/create-task/SKILL.md, and skills/update-task-files/SKILL.md.

6. Add a migration step to skills/close-tasks/SKILL.md: on each invocation, rename any remaining 'files' key to 'modifiableFiles' across the project's tasks.json, so the legacy key drains out over time even though readers still accept it.

The motivation for the read fence is real: task 50's planner produced a plan against a file that no longer existed because its read fence was scoped to its own owned files. Widening reads while keeping writes narrow fixes that without loosening ownership.

### scripts/prepareTasks.ts

```
// Writes task briefs, creates one worktree per file-disjoint group, prints WorkflowArguments. CLI entry point at bottom.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "./repositoryManifest.ts";
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
import { groupTasksByFileOverlap } from "./taskGroups.ts";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
};

export type PreparedGroup = {
    groupId: number;
    worktree: string;
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
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.filter((number): number is number => openNumbers.has(number as number));
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
            `these tasks declare no "files" and cannot be planned or implemented: ${numbers}. `
            + `A task's "files" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
    }
    return runnableTasks;
}

export function generateRunId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function resolveMergeScriptPath(): string {
    return join(import.meta.dirname, "mergeTaskWorktrees.ts");
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
    return `task-group-${groupId}`;
}

function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const fileSections = declaredFiles(task).map((file) => {
        const fullPath = join(repoRoot, file);
        if (!existsSync(fullPath)) return `### ${file}\n\n(missing: file not found on disk)\n`;
        return `### ${file}\n\n\`\`\`\n${readFileSync(fullPath, "utf8")}\n\`\`\`\n`;
    });
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}

// `git worktree add` leaves submodule directories empty; a worker needs them populated.
function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `group-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        execFileSync(
            "git",
            ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "HEAD"],
            { stdio: "ignore" },
        );
    }
    initializeSubmodulesInWorktree(worktreePath);
    createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName);
    return worktreePath;
}

export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}

function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
    const result = bootstrapRepositoryManifest(repoRoot);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const manifest = loadRepositoryManifest(repoRoot);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    // startTimestamp is stamped here because workflow scripts cannot call Date.now().
    const pipelineArguments = {
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: resolveMergeScriptPath(),
        repositoryManifest: manifest,
    };
    const argumentsFile = resolveRunArgumentsPath(repoRoot);
    mkdirSync(dirname(argumentsFile), { recursive: true });
    writeFileSync(argumentsFile, JSON.stringify(pipelineArguments));
    process.stdout.write(JSON.stringify({
        ...pipelineArguments,
        stepOutputsFile: resolveStepOutputsPath(repoRoot),
        mergeCommand: `node "${resolveMergePhaseScriptPath()}"`,
    }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/taskGroups.ts

```
// Groups tasks by shared file paths so disjoint groups can run in parallel. No-file tasks share one "unknown" group.
import type { TaskRecord } from "./taskFiles.ts";
import { buildCanonicalTaskGroups } from "./canonicalTaskGroups.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";

export type TaskGroupScope = "declared" | "unknown";

export type TaskGroup = {
    groupId: number;
    taskNumbers: number[];
    filePaths: string[];
    scope: TaskGroupScope;
};

export function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

// Manifest-free fallback for taskStats.ts: groups by exact shared file paths, files-less tasks share "unknown".
function groupTasksByExactFileOverlapWithNoManifest(tasks: TaskRecord[]): TaskGroup[] {
    const parent = new Map<number, number>();
    const find = (n: number): number => (parent.get(n) === n ? n : find(parent.set(n, find(parent.get(n)!)).get(n)!));
    const union = (a: number, b: number) => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootA, rootB);
    };
    for (const task of tasks) parent.set(task.taskNumber, task.taskNumber);

    const fileOwner = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) {
            const owner = fileOwner.get(file);
            if (owner === undefined) fileOwner.set(file, task.taskNumber);
            else union(task.taskNumber, owner);
        }
    }
    const unknownTasks = tasks.filter((task) => declaredFiles(task).length === 0);
    for (let i = 1; i < unknownTasks.length; i++) union(unknownTasks[0].taskNumber, unknownTasks[i].taskNumber);

    const componentsByRoot = new Map<number, TaskRecord[]>();
    for (const task of tasks) {
        const root = find(task.taskNumber);
        const bucket = componentsByRoot.get(root) ?? [];
        bucket.push(task);
        componentsByRoot.set(root, bucket);
    }

    const groups: TaskGroup[] = [...componentsByRoot.values()].map((members) => {
        const taskNumbers = members.map((m) => m.taskNumber).sort((a, b) => a - b);
        const filePaths = [...new Set(members.flatMap((m) => declaredFiles(m)))].sort();
        const scope: TaskGroupScope = filePaths.length > 0 ? "declared" : "unknown";
        return { groupId: 0, taskNumbers, filePaths, scope };
    });
    groups.sort((a, b) => a.taskNumbers[0] - b.taskNumbers[0]);
    return groups.map((group, index) => ({ ...group, groupId: index + 1 }));
}

export function groupTasksByFileOverlap(tasks: TaskRecord[], manifest?: RepositoryManifest): TaskGroup[] {
    if (manifest === undefined) return groupTasksByExactFileOverlapWithNoManifest(tasks);
    return buildCanonicalTaskGroups(tasks, manifest);
}

```

### scripts/approvalGate.ts

```
// approvalGate.ts: the single whole-run approval gate -- records approval, issues authorization, invalidates it on drift.
import { createHash } from "node:crypto";
import type { RepositoryManifest } from "./repositoryManifest.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { issueRunAuthorization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import { runFinalizer } from "./runFinalizer.ts";
import type { FinalizationRunInput, FinalizationRunResult } from "./runFinalizer.ts";

export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
    baseRef: string;
    occurrenceDigests: string[];
    testReceipts: TestReceipt[];
    reviewHandoffs: string[];
};

export type Approval = {
    digest: string;
    recordedAt: string;
};

export type RunState = {
    readyForApproval: boolean;
    status: string;
    digestInput: ApprovalDigestInput;
    approval?: Approval;
    authorization?: RunAuthorizationToken;
};

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const entries = keys.map(
            (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
        );
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export type OccurrenceSnapshot = { groupId: number; repositoryPath: string; treeListing: string };

// Hashes the whole sorted record, not a git oid, so deletions and gitlinks are just more bytes.
export function computeOccurrenceDigests(snapshots: OccurrenceSnapshot[]): string[] {
    return [...snapshots]
        .sort((a, b) => a.groupId - b.groupId || a.repositoryPath.localeCompare(b.repositoryPath))
        .map((snapshot) => createHash("sha256").update(stableStringify(snapshot)).digest("hex"));
}

export function recordApproval(runState: RunState): Approval {
    if (!runState.readyForApproval) {
        throw new Error("cannot record approval: run is not readyForApproval");
    }
    if (runState.approval !== undefined) {
        throw new Error("cannot record approval: this run already has an approval recorded");
    }
    const approval: Approval = {
        digest: computeApprovalDigest(runState.digestInput),
        recordedAt: new Date().toISOString(),
    };
    runState.approval = approval;
    return approval;
}

export function issueApprovalAuthorization(runState: RunState): RunAuthorizationToken {
    if (runState.approval === undefined) {
        throw new Error("cannot issue authorization before an approval is recorded");
    }
    const authorization = issueRunAuthorization(runState.approval.digest);
    runState.authorization = authorization;
    return authorization;
}

// Recomputes the digest; a mismatch invalidates approval/authorization and returns the run to review.
export function checkAuthorizationDrift(runState: RunState): boolean {
    if (runState.authorization === undefined) return true;
    const currentDigest = computeApprovalDigest(runState.digestInput);
    if (currentDigest === runState.authorization.stateDigest) return true;
    runState.authorization = undefined;
    runState.approval = undefined;
    runState.status = "review";
    return false;
}

export function finalizeApprovedRun(
    runState: RunState,
    finalizationInput: FinalizationRunInput,
): FinalizationRunResult {
    if (runState.authorization === undefined) {
        throw new Error("cannot finalize: run has no issued authorization");
    }
    return runFinalizer(finalizationInput, runState.authorization, computeApprovalDigest(runState.digestInput));
}

```

### scripts/mergePipeline.ts

```
// Translates the CLI's flat merge input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type WorkflowArguments } from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization, finalizeApprovedRun, computeApprovalDigest, type OccurrenceSnapshot, type RunState, type ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { validateRepositoryManifest, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
import { normalizeRepositoryIdentity, type RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import { consolidateRun, type GroupOccurrenceBranch, type LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import { pushOperationBranches, type OperationPushInput } from "./operationPush.ts";
import { publishBases, readCurrentRefOid, type PublicationTarget } from "./basePublication.ts";
import { summarizeTaskMergeResults, archivePublishedTasks, type RawTaskRepoOutcome } from "./taskArchival.ts";
import { runFinalization } from "./runAuthorization.ts";
export type CliInput = WorkflowArguments & {
    runId?: string; startTimestamp?: string; doneCount?: number; partialCount?: number; blockedCount?: number;
    needsClarificationCount?: number; requeueCount?: number; testReceipts?: TestReceipt[]; reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };
export type MergeOutcome = { groupId: number; merged: boolean; conflictedFilePaths: string[]; submoduleConflicts: SubmoduleConflict[]; worktree: string; failureReason: string | null };
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
type Coordinate = { repoRoot: string; relativePath: string };
type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}
function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }
function parseMergeTreeConflicts(stdout: string): string[] {
    const [, ...lines] = (stdout.split("\n\n")[0] ?? "").split("\n");
    return [...new Set(lines.filter(Boolean).map((line) => line.split("\t")[1]))];
}
function occurrenceToLogicalId(groups: LogicalGroup[], occurrenceId: string): string { return groups.find((g) => g.occurrenceIds.includes(occurrenceId))!.logicalId; }
function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
    const repoResolved = resolve(repo);
    const coordinates = new Map<string, Coordinate>();
    for (const occurrence of manifest.occurrences) {
        const repoRoot = occurrence.checkoutPath.startsWith("/") ? occurrence.checkoutPath : join(repo, occurrence.checkoutPath);
        const relativePath = repoRoot === repoResolved ? "" : relative(repoResolved, repoRoot);
        if (relativePath.startsWith("..")) throw new Error(`occurrence "${occurrence.occurrenceId}" checkout path "${repoRoot}" is outside repo "${repo}"`);
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
    const byKey = new Map<string, string[]>();
    for (const occurrence of manifest.occurrences) {
        const key = identityKey(occurrence);
        const existing = byKey.get(key);
        if (existing) existing.push(occurrence.occurrenceId); else byKey.set(key, [occurrence.occurrenceId]);
    }
    return [...byKey.entries()].map(([key, occurrenceIds]) => ({ logicalId: sanitizeSegment(key), occurrenceIds, canonicalOccurrenceId: occurrenceIds[0] }));
}
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
    const occurrenceToLogical = new Map<string, string>();
    for (const group of groups) for (const id of group.occurrenceIds) occurrenceToLogical.set(id, group.logicalId);
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const byId = new Map(groups.map((g) => [g.logicalId, g]));
    const mark = new Map<string, "gray" | "black">();
    const order: LogicalGroup[] = [];
    function visit(logicalId: string, path: string[]): void {
        if (mark.get(logicalId) === "black") return;
        if (mark.get(logicalId) === "gray") throw new Error(`logical repository dependency cycle: ${[...path, logicalId].join(" -> ")}`);
        mark.set(logicalId, "gray");
        const group = byId.get(logicalId)!;
        for (const occurrenceId of group.occurrenceIds) for (const childId of occurrenceById.get(occurrenceId)!.childOccurrenceIds) {
            const childLogicalId = occurrenceToLogical.get(childId)!;
            if (childLogicalId !== logicalId) visit(childLogicalId, [...path, logicalId]);
        }
        mark.set(logicalId, "black");
        order.push(group);
    }
    for (const group of groups) visit(group.logicalId, []);
    return order;
}
export async function runMergePipeline(input: CliInput): Promise<void> {
    const manifest = input.repositoryManifest;
    if (!manifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const validation = validateRepositoryManifest(manifest);
    if (!validation.valid) throw new Error(`invalid repository manifest: ${validation.errors.join("; ")}`);
    const roots = manifest.occurrences.filter((o) => o.parentOccurrenceId === null);
    if (roots.length !== 1) throw new Error(`repository manifest must have exactly one root occurrence, found ${roots.length}`);
    if (input.groups.length === 0) throw new Error("no groups given in CLI input");
    const rootOccurrence = roots[0];
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const runId = input.runId ?? `merge-${Date.now()}-${process.pid}`;
    execFileSync("git", ["check-ref-format", `refs/heads/${runId}/probe`]);
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const coordinates = buildCoordinates(input.repo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    const groupRepoRootFor = (groupWorktree: string, occurrenceId: string): string =>
        coordinates.get(occurrenceId)!.relativePath === "" ? groupWorktree : join(groupWorktree, coordinates.get(occurrenceId)!.relativePath);
    const rawTips = new Map<string, Map<number, string>>();
    for (const occurrence of manifest.occurrences) rawTips.set(occurrence.occurrenceId, new Map(sortedGroups.map((group) => [group.groupId, git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "rev-parse", "HEAD").trim()])));
    const baseMismatch = logicalGroups.find((group) => new Set(group.occurrenceIds.map((id) => occurrenceById.get(id)!.baseOid)).size > 1);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        let rootConflictedPaths: string[] = [];
        let failed = baseMismatch !== undefined;
        for (const occurrence of manifest.occurrences) {
            const coordinate = coordinates.get(occurrence.occurrenceId)!;
            const groupRepoRoot = groupRepoRootFor(group.worktree, occurrence.occurrenceId);
            const tipOid = rawTips.get(occurrence.occurrenceId)!.get(group.groupId)!;
            try {
                execFileSync("git", ["-C", groupRepoRoot, "merge-tree", "--write-tree", occurrence.baseOid, tipOid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            } catch (error) {
                failed = true;
                const conflictedPaths = parseMergeTreeConflicts((error as { stdout?: string }).stdout ?? "");
                if (coordinate.relativePath === "") rootConflictedPaths = conflictedPaths;
                else submoduleConflicts.push({ path: coordinate.relativePath, conflictedFilePaths: conflictedPaths, failureReason: null });
            }
        }
        const outcome: MergeOutcome = { groupId: group.groupId, merged: !failed, conflictedFilePaths: failed ? rootConflictedPaths : [], submoduleConflicts, worktree: group.worktree, failureReason: null };
        (failed ? conflicts : merged).push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0;
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => ({
        groupId: outcome.groupId, repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath,
        treeListing: git(groupRepoRootFor(outcome.worktree, occurrence.occurrenceId), "ls-tree", "-r", "-z", "HEAD"),
    })));
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const operationRef = digestIds(sortedGroups.flatMap((group) => manifest.occurrences.map((o) => `${group.groupId}:${o.occurrenceId}:${rawTips.get(o.occurrenceId)!.get(group.groupId)}`)));
    const readyForApproval = allGroupsMerged && testReceipts.length > 0 && testReceipts.every((receipt) => receipt.status === "green") && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    const endMetrics = (conflictCount: number): void => {
        const endTimestamp = new Date().toISOString();
        const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources };
        appendRunMetricsRecord(input.repo, {
            runId: input.runId ?? endTimestamp, startTimestamp: input.startTimestamp ?? null, endTimestamp,
            durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
            taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), groupCount: sortedGroups.length,
            doneCount: input.doneCount ?? 0, partialCount: input.partialCount ?? 0, blockedCount: input.blockedCount ?? 0,
            needsClarificationCount: input.needsClarificationCount ?? 0, requeueCount: input.requeueCount ?? 0,
            conflictCount, argumentsHash: computeArgumentsHash(workflowArguments),
        });
    };
    const printResult = (publicationTargets: PublicationTargetSummary[]): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets })); };
    if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
    recordApproval(runState);
    const token = issueApprovalAuthorization(runState);
    const digest = computeApprovalDigest(runState.digestInput);
    const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
        const consolidations = new Map<string, ConsolidationOutcome>();
        for (const logicalGroup of logicalGroups) {
            const canonicalRepoRoot = coordinates.get(logicalGroup.canonicalOccurrenceId)!.repoRoot;
            const canonicalOccurrence = occurrenceById.get(logicalGroup.canonicalOccurrenceId)!;
            const participatingBranches: GroupOccurrenceBranch[] = [];
            for (const occurrenceId of logicalGroup.occurrenceIds) {
                const occurrence = occurrenceById.get(occurrenceId)!;
                const occurrenceSegment = sanitizeSegment(occurrenceId);
                for (const group of sortedGroups) {
                    const repoRoot = groupRepoRootFor(group.worktree, occurrenceId);
                    const proxyId = (childId: string): string => `proxy-${sanitizeSegment(childId)}`;
                    const directChildEdges = occurrence.childOccurrenceIds.map((childId) => ({ pathInParent: occurrenceById.get(childId)!.pathInParent!, childOccurrenceId: proxyId(childId) }));
                    const proxyInputs = occurrence.childOccurrenceIds.map((childId) => {
                        const child = consolidations.get(occurrenceToLogicalId(logicalGroups, childId))!;
                        return { occurrenceId: proxyId(childId), repoRoot: child.canonicalRepoRoot, currentTipOid: child.preparedIntegrationOid, recordedBaseOid: child.preparedIntegrationOid, approvedOwnFileChanges: [], directChildEdges: [] };
                    });
                    const finalizationRunId = `${runId}-finalize-${sanitizeSegment(logicalGroup.logicalId)}-${group.groupId}`;
                    const result = finalizeApprovedRun(runState, {
                        runId: finalizationRunId,
                        occurrences: [{ occurrenceId: occurrenceSegment, repoRoot, currentTipOid: rawTips.get(occurrenceId)!.get(group.groupId)!, recordedBaseOid: rawTips.get(occurrenceId)!.get(group.groupId)!, approvedOwnFileChanges: [], directChildEdges }, ...proxyInputs],
                    });
                    const finalizedOid = result.occurrences.find((o) => o.occurrenceId === occurrenceSegment)!.finalizedIntegrationOid;
                    const groupSegment = String(group.groupId).padStart(6, "0");
                    if (repoRoot !== canonicalRepoRoot) git(canonicalRepoRoot, "fetch", repoRoot, finalizedOid);
                    git(canonicalRepoRoot, "update-ref", `refs/heads/${groupSegment}/${occurrenceSegment}`, finalizedOid);
                    participatingBranches.push({ groupId: groupSegment, occurrencePath: occurrenceSegment, occurrenceId, branchOid: finalizedOid, sourceRepoRoot: canonicalRepoRoot });
                }
            }
            const sorted = [...participatingBranches].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.occurrencePath.localeCompare(b.occurrencePath));
            let previewOid = sorted[0].branchOid;
            for (let i = 1; i < sorted.length; i++) {
                const foldResult = prepareNoFfMerge(canonicalRepoRoot, previewOid, sorted[i].branchOid, `preview fold ${runId}`);
                if (!foldResult.merged) return true; else previewOid = foldResult.commitOid;
            }
            const approvedConvergedTreeOid = git(canonicalRepoRoot, "rev-parse", `${previewOid}^{tree}`).trim();
            const consolidationInput: LogicalRepositoryConsolidationInput = {
                logicalRepositoryId: logicalGroup.logicalId, canonicalRepoRoot, canonicalOccurrenceBranchName: sanitizeSegment(logicalGroup.logicalId),
                participatingBranches, approvedConvergedTreeOid, finalizedChildGitlinks: [],
                recordedBaseOid: canonicalOccurrence.baseOid, baseBranchRef: `refs/heads/${canonicalOccurrence.baseBranch}`,
            };
            const [result] = consolidateRun(runId, [consolidationInput], token, digest);
            if ("aborted" in result) return true;
            const integrationRef = `refs/finalize/${runId}/integration/${sanitizeSegment(logicalGroup.logicalId)}`;
            git(canonicalRepoRoot, "update-ref", integrationRef, result.preparedIntegrationOid);
            consolidations.set(logicalGroup.logicalId, { preparedIntegrationOid: result.preparedIntegrationOid, canonicalRepoRoot, canonicalRefName: `refs/heads/${canonicalOccurrence.baseBranch}`, recordedBaseOid: canonicalOccurrence.baseOid, integrationRef });
        }
        const operationPushOccurrences = manifest.occurrences.map((occurrence) => {
            const logicalGroup = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}` };
        });
        const operationPushLogicalRepositories: LogicalRepository[] = logicalGroups.map((group) => ({
            normalizedIdentity: normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? ({ host: "opaque", owner: "opaque", repository: group.logicalId } as RepositoryIdentity),
            occurrenceIds: group.occurrenceIds, selectedBaseOccurrenceId: group.canonicalOccurrenceId, canonicalOccurrenceId: group.canonicalOccurrenceId,
            lastWriterOccurrenceId: group.occurrenceIds[group.occurrenceIds.length - 1], convergenceDigest: digestIds(group.occurrenceIds),
            consolidationState: group.occurrenceIds.length === 1 ? "single" : "grouped",
        }));
        await pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest);
        for (const occurrence of manifest.occurrences) if (readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`) !== occurrence.baseOid) return true;
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
            const consolidation = consolidations.get(group.logicalId)!;
            return {
                name: group.logicalId, canonicalOccurrencePath: consolidation.canonicalRepoRoot, canonicalRefName: consolidation.canonicalRefName,
                otherOccurrences: group.occurrenceIds.filter((id) => id !== group.canonicalOccurrenceId).map((id) => ({ path: coordinates.get(id)!.repoRoot, refName: `refs/heads/${occurrenceById.get(id)!.baseBranch}` })),
                recordedBaseOid: consolidation.recordedBaseOid, targetOid: consolidation.preparedIntegrationOid,
            };
        });
        const rootConsolidation = consolidations.get(logicalGroups.find((g) => g.occurrenceIds.includes(rootOccurrence.occurrenceId))!.logicalId)!;
        const publicationResult = publishBases(publicationTargets, runState, { repoPath: rootConsolidation.canonicalRepoRoot, refName: rootConsolidation.integrationRef });
        if (!publicationResult.published) return true;
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
            taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
        }))));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        endMetrics(0);
        printResult(summaryTargets);
        return false;
    });
    if (aborted) { endMetrics(conflicts.length + 1); printResult([]); }
}

```

### skills/tackle-tasks/plan.workflow.js

```
export const meta = {
  name: 'tackle-tasks-plan',
  description: 'Write one plan file per task, one planner agent each',
  phases: [{ title: 'Plan', detail: 'one planner agent per task' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const PLAN_MODEL = ARGS.planModel

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['task', 'status', 'planFile', 'question'],
}

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the owned list above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.

You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`

const TASKS = GROUPS.flatMap((g) => g.tasks)
log(`planning ${TASKS.length} task(s)`)

const runPlanner = (t) => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return agent(plannerBrief(t), options)
}

const results = await parallel(TASKS.map((t) => () => runPlanner(t)))
const plans = TASKS.map((t, i) => results[i] ?? {
  task: t.number,
  status: 'needs-clarification',
  planFile: '',
  question: 'planner returned no result',
})

return {
  plans,
  planned: plans.filter((p) => p.status === 'planned'),
  needsClarification: plans.filter((p) => p.status === 'needs-clarification'),
  notRelevant: plans.filter((p) => p.status === 'not-relevant'),
}

```

### skills/tackle-tasks/implement.workflow.js

```
export const meta = {
  name: 'tackle-tasks-implement',
  description: 'Implement each approved plan with jot:implement, serially per group',
  phases: [{ title: 'Implement', detail: 'serial workers per group, one-pass requeue for partial' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const APPROVED = ARGS.approved ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'summary', 'remaining'],
}

const tddInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task from
./.taskTools/tasks.json: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = ${t.files.join(', ')}
plan = ${planFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

use jot:implement ${planFile}

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: []}

implement every step of the plan, editing only ownedFiles

typecheck = run(${TYPECHECK_COMMAND})
if typecheck reported errors in ownedFiles:
    fix them

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run(tests)
fixRound = 0
while any test failed and fixRound is less than ${MAX_FIX_ROUNDS}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${TYPECHECK_COMMAND})
    results = run(tests)

if any test still failed after ${MAX_FIX_ROUNDS} fix rounds:
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names}

if typecheck is clean and every test passed:
    run: ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- (every path you edited, listed explicitly)'}
    run: git commit -m "task ${t.number}: one-line summary"
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: []}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining

You are forbidden to touch anything outside ownedFiles; to add scope or
refactors the plan does not call for; to redecide anything the plan already
decided; to run the full suite, \`git add -A\`, or \`git add .\`; to commit while
anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix rounds; or to return
status "done" with a failing test.`

const planFileFor = (task) => APPROVED.find((a) => a.task === task)?.planFile ?? ''

const runWorker = (t, group, note) => {
  const options = { label: `task:${t.number}`, phase: 'Implement', schema: WORKER_SCHEMA }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return agent(workerBrief(t, group, planFileFor(t.number), note), options)
}

let requeueCount = 0

async function implementGroup(group) {
  const tasks = group.tasks.filter((t) => APPROVED.some((a) => a.task === t.number))
  const results = []
  for (const t of tasks) {
    const result = await runWorker(t, group, '')
    results.push(result ?? {
      task: t.number,
      status: 'blocked',
      summary: 'worker agent returned no result (killed, errored, or blocked)',
      remaining: [],
    })
  }

  for (const r of results.filter((r) => r.status === 'partial')) {
    requeueCount++
    const t = tasks.find((task) => task.number === r.task)
    const note = `A previous worker finished part of this plan; still remaining: ${r.remaining.join('; ')}. Check the file state before redoing anything.`
    const redone = await runWorker(t, group, note)
    results[results.findIndex((x) => x.task === r.task)] = redone ?? r
  }

  return results
}

log(`implementing ${APPROVED.length} approved task(s) across ${GROUPS.length} group(s)`)
const perGroup = await parallel(GROUPS.map((g) => () => implementGroup(g)))
const results = perGroup.filter(Boolean).flat()

return {
  results,
  done: results.filter((r) => r.status === 'done'),
  partial: results.filter((r) => r.status === 'partial'),
  blocked: results.filter((r) => r.status === 'blocked'),
  requeueCount,
}

```

### skills/tackle-tasks/test.workflow.js

```
export const meta = {
  name: 'tackle-tasks-test',
  description: 'Run the tests covering each group and have a worker fix failures until they pass',
  phases: [
    { title: 'Test', detail: 'report-only test run per group, repeated until green' },
    { title: 'Fix', detail: 'one worker per failing task between test rounds' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const DONE = ARGS.done ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const MAX_ROUNDS = ARGS.maxRounds ?? 3

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'integer' }, detail: { type: 'string' } },
        required: ['task', 'detail'],
      },
    },
  },
  required: ['passed', 'failures'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['task', 'fixed', 'summary'],
}

const testerBrief = (group, tasks) => `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = {
${tasks.map((t) => `    task ${t.number}: ${t.files.join(', ')}`).join('\n')}
}
failures = []

typecheck = run(${TYPECHECK_COMMAND})

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite

results = run(tests)

for each task in ownedFiles:
    if typecheck reported an error in that task's files, or any of its tests failed:
        failures += {task: that task number, detail: the failing test names plus a short error summary}

if typecheck is clean and every test in results passed:
    return {passed: true, failures: []}
else:
    return {passed: false, failures: failures}

You are forbidden to edit any file, to run the full suite, or to report passed
true while any test failed or typecheck reported an error.`

const planFileFor = (task) => (ARGS.approved ?? []).find((a) => a.task === task)?.planFile ?? ''

const fixerBrief = (t, group, detail) => `You implemented task #${t.number} and wrote its tests. One of them
is now failing.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = ${t.files.join(', ')}
plan = ${planFileFor(t.number) || '(no plan file recorded)'}
failure = ${detail}

read(plan)   // the fix must match what the task set out to do

if the plan is wrong:
    return {task: ${t.number}, fixed: false, summary: why the plan itself is wrong}
else if the code is wrong:
    fix the code so the test passes as written
else if the test asserts something the plan did not call for:
    correct the test to assert what the plan called for
    note in summary that you changed the test, and why

typecheck = run(${TYPECHECK_COMMAND})
results = run(the tests covering ownedFiles)

if typecheck is clean and every test passed:
    run: git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}
    run: git commit -m "task ${t.number}: fix failing test"
    return {task: ${t.number}, fixed: true, summary: what you changed}
else:
    return {task: ${t.number}, fixed: false, summary: what is still failing}

You are forbidden to touch anything outside ownedFiles; to weaken, skip, or
delete a test to make it pass; to assert the current wrong output as the
expected value; to run \`git add -A\` or \`git add .\`; to commit while anything
fails; or to redecide the plan yourself.`

async function testGroup(group) {
  const tasks = group.tasks.filter((t) => DONE.some((d) => d.task === t.number))
  if (!tasks.length) return { groupId: group.groupId, passed: true, rounds: 0, failures: [], notes: 'no implemented tasks to test' }

  const taskByNumber = new Map(tasks.map((t) => [t.number, t]))
  let outcome = null

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const result = await agent(testerBrief(group, tasks), {
      label: `test:${group.groupId}:r${round}`,
      phase: 'Test',
      effort: 'low',
      schema: TEST_SCHEMA,
    })
    outcome = result ?? { passed: false, failures: tasks.map((t) => ({ task: t.number, detail: 'test agent returned no result' })) }

    if (outcome.passed) return { groupId: group.groupId, passed: true, rounds: round, failures: [], notes: '' }
    if (round === MAX_ROUNDS) break

    const fixable = outcome.failures.filter((f) => taskByNumber.has(f.task))
    if (!fixable.length) break

    log(`group ${group.groupId} round ${round}: fixing ${fixable.length} failing task(s)`)
    await parallel(fixable.map((f) => () =>
      agent(fixerBrief(taskByNumber.get(f.task), group, f.detail), {
        label: `fix:${f.task}:r${round}`,
        phase: 'Fix',
        schema: FIX_SCHEMA,
      })))
  }

  return {
    groupId: group.groupId,
    passed: false,
    rounds: MAX_ROUNDS,
    failures: outcome?.failures ?? [],
    notes: `still failing after ${MAX_ROUNDS} round(s)`,
  }
}

log(`testing ${GROUPS.length} group(s), up to ${MAX_ROUNDS} round(s) each`)
const tests = (await parallel(GROUPS.map((g) => () => testGroup(g)))).filter(Boolean)

const testReceipts = tests.map((t) => ({ groupId: String(t.groupId), status: t.passed ? 'green' : 'red' }))

return { tests, allPassed: tests.every((t) => t.passed), testReceipts }

```

### skills/tackle-tasks/verify.workflow.js

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex (or Claude when codex is down), apply its fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one verifier per planned task, one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    revised: { type: 'boolean' },
    notes: { type: 'string' },
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
  },
  required: ['task', 'verdict', 'revised', 'notes', 'reviewer'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const prompt = JSON.stringify(codexPrompt(t, planFile))
  const command = `codex exec -s read-only ${prompt}`
  // ponytail: opus/high, not fable/medium — the fallback replaces the strictest gate in the pipeline
  const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`
  const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

If that command exits with an error code, codex is unavailable — not a
verdict. Unavailability looks like a non-zero exit with no APPROVED or
REJECTED first line and no PROBLEMS or FIXES block: overloaded api, usage
exceeded, not logged in, rate limited, or no codex binary on PATH. In that
case run this command instead, and treat its output exactly as you would
codex's:

${fableFallbackCommand}
if that command also exits with an error code, run this command instead, and treat its output exactly as you would codex's:

${opusFallbackCommand}

Whichever reviewer answers prints its verdict on the first line. The only
file you may ever edit is the plan file ${planFile} — never touch a source
file, and never run any command other than the two above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.

If the first run prints APPROVED:
  return verdict "approved", revised false, and the reviewer's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what the reviewer asked for — edit only that file. Then run that same
  reviewer's command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put the reviewer's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If the reviewer said the plan cannot be fixed within the task's owned files, do
  not invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never review more than twice in total, counting codex and the fallback together.
Return {task: ${t.number}, verdict, revised, notes, reviewer}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
  reviewer: 'none',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

const reviewHandoffs = verified.map((v) => `task ${v.task}: ${v.verdict} by ${v.reviewer}${v.revised ? ' (revised)' : ''} - ${v.notes}`)

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
  reviewHandoffs,
}

```

### skills/create-task/SKILL.md

```
---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
---

- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`

Task described by the user: $ARGUMENTS

Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:

```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.

If `specs/SPEC.md` exists and this task belongs to one of its spec items, append the task number to that item's `Tasks:` line.

Omit completion-related fields (`completionDate`, `commitHashes`, `closureNote`) — those belong to `completedTasks.json`, which this skill never touches.

Finally, confirm to the user: the task number and title that were added.

```

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "description": "<the task in the user's own wording, plus any refinements gathered; include file paths and repro URLs if given>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}

```

### skills/update-task-files/SKILL.md

```
---
name: update-task-files
description: backfill the `files` array on existing tasks in tasks.json so they can be planned and implemented by tackle-tasks. Use when tackle-tasks refuses a task for declaring no files, or when auditing tasks created before the field existed.
argument-hint: "[N,N,...]"
---

- repo root: !`pwd`
- task details: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

First, invoke `/ponytail:ponytail ultra`.

Add a `files` array to each task shown above, inserted after `description`. If a task
already has one, verify it against the current codebase rather than rewriting it.

Invocation format: the first argument is a JSON array of task numbers with **no spaces** —
`[332,335]`. If no numbers were given, the block above lists every task; ask the user which
ones to backfill rather than rewriting all of them.

## Path rules

- Repo-relative to the repo root printed above — the directory holding `tasks.json`. Never
  absolute, never relative to a subdirectory.
- Files inside a git submodule are still written relative to that same root, so they carry
  the submodule directory as a prefix (for example `jfred/tests/layer1-filenav.test.ts`).
- Every path must already exist on disk. Verify each one. A path that does not resolve
  silently degrades the task's brief to `(missing: file not found)` at run time.
- Include implementation files and their test files.

## Why accuracy matters

This list is load-bearing, not documentation. Two mechanisms read it:

1. **Ownership fence.** The worker implementing the task is told "touch nothing outside
   them". Under-declaring blocks the worker from files it needs.
2. **Concurrency key.** Tasks sharing any path are sequenced together inside one git
   worktree; tasks with disjoint paths run in parallel in separate worktrees.
   Over-declaring serializes work that could have run concurrently. Under-declaring lets
   two workers edit the same file in different worktrees, which surfaces later as a merge
   conflict.

List what the task genuinely touches — not the whole module, and not one file when the
change spans three.

## When you cannot tell

If a task is too vague to determine its files, leave that task's `files` field out and
report its number. A wrong list is worse than no list: the task will simply be refused
again, which is the correct outcome for a task that needs rethinking rather than
annotating.

## Editing rules

- Edit `tasks.json` in place. Do **not** use the `create-task` skill — that skill appends
  new tasks, and this is a field backfill on existing ones. The rule against editing
  `tasks.json` directly governs *adding* tasks, which this skill does not do.
- Never touch `completedTasks.json`.
- Preserve every existing field, key order, task order, and task number. Do not reformat,
  reorder, renumber, or drop any entry.
- Change no source code.

## Verify before reporting

- The task count in `tasks.json` is unchanged.
- Every path you added exists: check each one on disk.
- `git diff` shows changes to `tasks.json` only.

## Report

A table of task number to files, then a separate list of the task numbers you left without
a `files` field, each with the reason it could not be determined.

```

### skills/close-tasks/SKILL.md

```
---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *)
---

- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in `$ARGUMENTS` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Close every listed OPEN task in a single pass: move its object from `tasks.json` to `completedTasks.json`, adding a `completionDate` (today), `commitHashes` (search git history for the resolving commits; use an empty array if none can be identified), and a short `closureNote` — one sentence per task, using the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none.

Skip tasks already COMPLETED or not found, and say so.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.

```

### tests/prepareTasks.test.ts

```
// Behavioral checks for prepareTasks.ts: brief writing, worktree creation, workflow args.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "prepare-tasks-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): { repoRoot: string; submoduleOrigin: string } {
    const submoduleOrigin = makeTempRepoWithCommit();
    writeFileSync(join(submoduleOrigin, "inner.txt"), "SUBMODULE-MARKER\n");
    git(submoduleOrigin, "add", "inner.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "inner");
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return { repoRoot, submoduleOrigin };
}

test("test_writeTaskBriefFileEmbedsTheDeclaredFileContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /MARKER-abc123/);
});

test("test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 2, title: "t2", description: "desc", files: ["missing.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /missing\.txt/);
    assert.match(text, /missing/i);
});

test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const first = createWorktreeForGroup(repoRoot, group);
    const second = createWorktreeForGroup(repoRoot, group);
    assert.equal(second, first);
});

test("test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    const sourceTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run hands a worker the same path.
    createWorktreeForGroup(repoRoot, group);
    // Verification: the worker gets the source branch tip, not the earlier run's codebase.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), sourceTip);
    assert.equal(existsSync(join(worktreePath, "fresh.txt")), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
});

test("test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees", () => {
    // Setup: a repo whose `vendor/` submodule holds a file with a known marker.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Test action: create the worktree a worker agent would be handed.
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: the submodule directory holds its files instead of being empty.
    assert.equal(existsSync(join(worktreePath, "vendor", "inner.txt")), true);
});

test("test_createWorktreeForGroupThrowsWhenSubmoduleInitFails", () => {
    // Setup: a repo with a submodule whose origin no longer exists on disk.
    const { repoRoot, submoduleOrigin } = makeTempRepoWithLocalSubmodule();
    rmSync(submoduleOrigin, { recursive: true, force: true });
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Verification: the run stops rather than handing a worker a half-populated worktree.
    assert.throws(() => createWorktreeForGroup(repoRoot, group));
});

test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});

test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("test_generateRunIdProducesDifferentValuesOnEachCall", () => {
    const first = generateRunId();
    const second = generateRunId();
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
});

test("test_mergeScriptPathPointsAtTheSiblingMergeScriptAsAnAbsolutePath", () => {
    const path = resolveMergeScriptPath();
    assert.equal(isAbsolute(path), true);
    assert.match(path, /mergeTaskWorktrees\.ts$/);
});

test("test_selectRequestedTasksRefusesToRunWhenNoTaskNumbersWereGiven", () => {
    // Setup: two open tasks and an empty requested-numbers list.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Verification: throws instead of falling back to every open task.
    assert.throws(() => selectRequestedTasks(openTasks, []), /no task numbers/i);
});

test("test_selectRequestedTasksRefusesWhenARequestedNumberIsNotOpen", () => {
    // Setup: open tasks 1 and 2, with 9 requested alongside them.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Test action and verification: the missing number is named in the error, rather than dropped.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 9]), /9/);
});

test("test_selectRequestedTasksExcludesTasksBlockedByAnOpenTask", () => {
    // Setup: task 2 is blocked by open task 1; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1], files: ["b.ts"] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: only the unblocked task survives, so no worktree is built for blocked work.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksRefusesTasksWithNoFilesArray", () => {
    // Setup: task 1 declares files, task 2 has no files key at all; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2 }];
    // Verification: the run stops and names only the undeclared task.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 2]), /\b2\b/);
});

test("test_selectRequestedTasksTreatsAnEmptyFilesArrayAsUndeclared", () => {
    // Setup: task 1 carries an explicitly empty files array.
    const openTasks = [{ taskNumber: 1, files: [] }];
    // Verification: an empty array is refused like a missing one — no ownership fence.
    assert.throws(() => selectRequestedTasks(openTasks, [1]), /files/i);
});

test("test_selectRequestedTasksIgnoresMissingFilesOnABlockedTask", () => {
    // Setup: task 2 is blocked by open task 1 and declares no files; task 1 declares files.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: the blocked task is dropped before the files check, not stopping the run.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksPointsAtTheUpdateTaskFilesSkillThatActuallyExists", () => {
    // Setup: one requested task with no files, and the skill directory on disk.
    const openTasks = [{ taskNumber: 7 }];
    // Test action: capture the refusal message.
    let message = "";
    try { selectRequestedTasks(openTasks, [7]); } catch (error) { message = (error as Error).message; }
    // Verification: message names update-task-files, and its SKILL.md exists, so the pointer can't rot.
    assert.match(message, /update-task-files/);
    assert.ok(existsSync(join(import.meta.dirname, "..", "skills", "update-task-files", "SKILL.md")));
});

test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1")), false);
});

test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});

```

### tests/prepareTasksIntegration.test.ts

```
// Integration coverage for prepareTasks against a real, on-disk git repository with a real submodule.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";
import { getOwningOccurrence } from "../scripts/repositoryGraph.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
const prepareTasksModulePath = new URL("../scripts/prepareTasks.ts", import.meta.url).href;
import type { TaskRecord } from "../scripts/taskFiles.ts";

function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
}

const rootPath = mkdtempSync(join(tmpdir(), "prepareTasksIntegration-"));
const submoduleSourcePath = mkdtempSync(join(tmpdir(), "prepareTasksIntegrationSubmoduleSource-"));

// Git blocks local-path submodules; only global config survives into the nested clone.
const gitConfigPath = join(rootPath, "allow-file-transport.gitconfig");
writeFileSync(gitConfigPath, '[protocol "file"]\n\tallow = always\n');
process.env.GIT_CONFIG_GLOBAL = gitConfigPath;

git(rootPath, ["init", "-q", "-b", "main"]);
git(rootPath, ["config", "user.email", "test@example.com"]);
git(rootPath, ["config", "user.name", "Test"]);
execFileSync("mkdir", ["-p", join(rootPath, "scripts")]);
execFileSync("bash", ["-c", `echo 'export const foo = 1;' > "${join(rootPath, "scripts", "foo.ts")}"`]);
git(rootPath, ["add", "scripts/foo.ts"]);
git(rootPath, ["commit", "-q", "-m", "add foo"]);
git(rootPath, ["remote", "add", "origin", "https://example.com/root.git"]);
git(rootPath, ["config", "protocol.file.allow", "always"]);

git(submoduleSourcePath, ["init", "-q", "-b", "main"]);
git(submoduleSourcePath, ["config", "user.email", "test@example.com"]);
git(submoduleSourcePath, ["config", "user.name", "Test"]);
execFileSync("mkdir", ["-p", join(submoduleSourcePath, "src")]);
execFileSync("bash", ["-c", `echo 'export const bar = 1;' > "${join(submoduleSourcePath, "src", "bar.ts")}"`]);
git(submoduleSourcePath, ["add", "src/bar.ts"]);
git(submoduleSourcePath, ["commit", "-q", "-m", "add bar"]);

git(rootPath, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", submoduleSourcePath, "external/sub"]);
git(rootPath, ["commit", "-q", "-m", "add submodule"]);

const bootstrapResult = bootstrapRepositoryManifest(rootPath);
assert.equal(bootstrapResult.refused, false, "bootstrap must resolve without needing manual input");
const occurrenceGraph: RepositoryOccurrence[] = bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph;
const manifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: occurrenceGraph };

after(() => {
    rmSync(join(tmpdir(), "taskTools-wt", basename(rootPath)), { recursive: true, force: true });
    rmSync(rootPath, { recursive: true, force: true });
    rmSync(submoduleSourcePath, { recursive: true, force: true });
});

test("test_ownershipResolvesForARootFilePath", () => {
    const owner = getOwningOccurrence("scripts/foo.ts", manifest);
    assert.ok(owner);
    assert.equal(owner!.parentOccurrenceId, null);
});

test("test_ownershipResolvesForASubmoduleFilePath", () => {
    const root = manifest.occurrences.find((occurrence) => occurrence.parentOccurrenceId === null);
    assert.ok(root);
    const owner = getOwningOccurrence("external/sub/src/bar.ts", manifest);
    assert.ok(owner);
    assert.equal(owner!.parentOccurrenceId, root!.occurrenceId);
});

test("test_everyOccurrenceHasANonEmptyOriginUrl", () => {
    for (const occurrence of manifest.occurrences) {
        assert.notEqual(occurrence.originUrl, "");
    }
});

test("test_groupTasksByFileOverlapReturnsRealGroupsInsteadOfThrowing", () => {
    const tasks: TaskRecord[] = [
        { taskNumber: 1, files: ["scripts/foo.ts"] },
        { taskNumber: 2, files: ["external/sub/src/bar.ts"] },
    ];
    const groups = groupTasksByFileOverlap(tasks);
    assert.ok(groups.length > 0);

    // Bun drops process.env edits for children, so only a spawned process can carry the git override.
    const script = `
        const { buildWorkflowArguments } = await import(${JSON.stringify(prepareTasksModulePath)});
        const built = buildWorkflowArguments(${JSON.stringify(rootPath)}, "npx tsc --noEmit", ${JSON.stringify(groups)});
        process.stdout.write(String(built.groups.length));
    `;
    const groupCount = execFileSync("bun", ["-e", script], {
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
    });
    assert.ok(Number(groupCount) > 0);
});

```

### tests/taskGroups.test.ts

```
// Behavioral checks for taskGroups.ts: pure file-overlap grouping, no I/O.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTasksByFileOverlap } from "../scripts/taskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";
import type { RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { REPOSITORY_MANIFEST_VERSION } from "../scripts/repositoryManifest.ts";

function task(taskNumber: number, files?: string[]): TaskRecord {
    return files === undefined ? { taskNumber } : { taskNumber, files };
}

const flatManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [
        {
            occurrenceId: "flat",
            checkoutPath: "",
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "https://local/flat/flat.git",
            baseBranch: "main",
            baseOid: "0".repeat(40),
            operationBranch: "main",
            childOccurrenceIds: [],
            testState: "untested",
        },
    ],
};

test("test_groupTasksByFileOverlapPutsTasksSharingAFileInOneGroup", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

test("test_groupTasksByFileOverlapSeparatesTasksWithNoSharedFile", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileB"])], flatManifest);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.taskNumbers), [[1], [2]]);
});

test("test_groupTasksByFileOverlapJoinsTasksLinkedThroughAThirdTask", () => {
    const groups = groupTasksByFileOverlap([
        task(1, ["fileA"]),
        task(2, ["fileB"]),
        task(3, ["fileA", "fileB"]),
    ], flatManifest);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2, 3]);
});

test("test_groupTasksByFileOverlapPutsTasksWithoutDeclaredFilesInTheUnknownGroup", () => {
    const groups = groupTasksByFileOverlap([task(1), task(2), task(3, ["fileA"])], flatManifest);
    assert.equal(groups.length, 2);
    const unknownGroup = groups.find((g) => g.scope === "unknown");
    const declaredGroup = groups.find((g) => g.scope === "declared");
    assert.deepEqual(unknownGroup?.taskNumbers, [1, 2]);
    assert.deepEqual(declaredGroup?.taskNumbers, [3]);
});

test("test_groupTasksByFileOverlapOrdersGroupsAndTaskNumbersAscending", () => {
    const groups = groupTasksByFileOverlap([
        task(9, ["fileB"]),
        task(3, ["fileA"]),
        task(5, ["fileB"]),
    ], flatManifest);
    assert.equal(groups[0].taskNumbers[0], 3);
    const groupWithNine = groups.find((g) => g.taskNumbers.includes(9));
    assert.deepEqual(groupWithNine?.taskNumbers, [5, 9]);
});

test("test_groupTasksByFileOverlapStillWorksWithNoManifestArgument", () => {
    const groups = groupTasksByFileOverlap([task(1, ["fileA"]), task(2, ["fileA"])]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].taskNumbers, [1, 2]);
});

```
