// "did every change stay inside the task's owned files?" (pipeline.mmd). Derives the diff itself.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { buildDiscoveryManifest, buildOccurrencePath, buildOwnedOccurrencePaths, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { modifiableFiles } from "../../prepareTasks.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { logStepOutput } from "./logStepOutput.ts";

export type CheckTaskFileFenceInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    rootSourceBranch: string;
};

export type CheckTaskFileFenceOutput = { inside: boolean; violations: string[] };

function git(checkoutPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", checkoutPath, ...args], { encoding: "utf8" });
}

function declaredFiles(taskNumber: number, projectRoot: string): string[] {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    return modifiableFiles(task);
}

function readGitlinkOidAtHead(checkoutPath: string, pathInParent: string): string | null {
    try {
        return git(checkoutPath, "rev-parse", `HEAD:${pathInParent}`).trim();
    } catch {
        return null;
    }
}

// F10: deepest-first, so a parent gitlink is exempt only when its own child occurrence proves it.
export function computeExemptGitlinkPaths(
    worktreePath: string,
    projectRoot: string,
    rootSourceBranch: string,
    changedPathsByOccurrenceId: Map<string, string[]>,
    ownedPaths: Set<string>,
): Set<string> {
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot, rootSourceBranch);
    const occurrencesById = new Map(manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const deepestFirst = [...manifest.repositoryManifest.occurrences].sort((a, b) => b.depth - a.depth);

    const exempt = new Set<string>();
    for (const occurrence of deepestFirst) {
        if (occurrence.parentOccurrenceId === null || occurrence.pathInParent === null) continue;
        // Condition 4: the gitlink must be a direct parent/child relation in the discovered graph.
        const parent = occurrencesById.get(occurrence.parentOccurrenceId);
        if (parent === undefined) continue;

        const gitlinkPath = buildOccurrencePath(occurrence.parentOccurrenceId, occurrence.pathInParent);
        const childChangedPaths = changedPathsByOccurrenceId.get(occurrence.occurrenceId) ?? [];
        // Condition 1: the child occurrence contains at least one task change.
        const childHasAChange = childChangedPaths.length > 0;
        // Condition 2: every non-structural child change sits inside the owned occurrence paths.
        const nonStructuralChildChanges = childChangedPaths.filter((path) => !exempt.has(path));
        const everyNonStructuralChangeIsOwned = nonStructuralChildChanges.every((path) => ownedPaths.has(path));
        // Condition 3: the parent's recorded gitlink equals the child checkout's actual HEAD.
        const parentGitlinkOid = readGitlinkOidAtHead(parent.checkoutPath, occurrence.pathInParent);
        const childHeadOid = git(occurrence.checkoutPath, "rev-parse", "HEAD").trim();
        const gitlinkMatchesChildHead = parentGitlinkOid !== null && parentGitlinkOid === childHeadOid;

        if (childHasAChange && everyNonStructuralChangeIsOwned && gitlinkMatchesChildHead) {
            exempt.add(gitlinkPath);
        }
    }
    return exempt;
}

export function checkTaskFileFence(input: CheckTaskFileFenceInput): CheckTaskFileFenceOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    requireAbsolutePath("worktreePath", input.worktreePath);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshOwnedSourceRepoLockOrThrow(input.projectRoot, owner);

    const declared = declaredFiles(input.taskNumber, input.projectRoot);
    // A task that declares "*" owns every path, so nothing can fall outside its fence.
    if (declared.includes("*")) return { inside: true, violations: [] };
    const occurrences = getOccurrencesDeepestFirst(input.worktreePath, input.projectRoot, input.rootSourceBranch);
    const ownedPaths = new Set(buildOwnedOccurrencePaths(declared, occurrences));

    const changedPathsByOccurrenceId = new Map<string, string[]>();
    const allChangedPaths: string[] = [];
    for (const occurrence of occurrences) {
        const relativePaths = git(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`)
            .split("\n").filter(Boolean);
        const taggedPaths = relativePaths.map((relativePath) => buildOccurrencePath(occurrence.occurrenceId, relativePath));
        changedPathsByOccurrenceId.set(occurrence.occurrenceId, taggedPaths);
        allChangedPaths.push(...taggedPaths);
    }

    const exemptGitlinkPaths = computeExemptGitlinkPaths(input.worktreePath, input.projectRoot, input.rootSourceBranch, changedPathsByOccurrenceId, ownedPaths);

    // ponytail: the pipeline's own resume bookkeeping file, exempt like in checkResumedWorktreeFence.
    const violations = allChangedPaths.filter((path) => path !== "plans/checkpoint.json" && !ownedPaths.has(path) && !exemptGitlinkPaths.has(path));
    return { inside: violations.length === 0, violations };
}

const CHECK_TASK_FILE_FENCE_SOURCE = "scripts/tackle-tasks/checkTaskFileFence.ts:76: checkTaskFileFence";

if (process.argv[1]?.endsWith("checkTaskFileFence.ts")) {
    const payloadText = readFileSync(0, "utf8");
    const input = JSON.parse(payloadText) as CheckTaskFileFenceInput & { boxId?: string };
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
    const boxId = input.boxId ?? "checkTaskFileFence";
    const command = `node ${process.argv[1]} <<'TTFENCE'\n${payloadText}\nTTFENCE`;

    try {
        const output = checkTaskFileFence(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: CHECK_TASK_FILE_FENCE_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: CHECK_TASK_FILE_FENCE_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
