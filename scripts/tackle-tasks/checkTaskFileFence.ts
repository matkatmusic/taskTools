// "did every change stay inside the task's owned files?" (pipeline.mmd). Computes the diff
// itself, deepest-first over every occurrence; never trusts a self-reported changedPaths.
// Both the diff and task.files go through buildOccurrencePath/buildOwnedOccurrencePaths so the
// two namespaces are comparable. A violation always exits; there is no in-run widening.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { buildDiscoveryManifest, buildOccurrencePath, buildOwnedOccurrencePaths, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

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
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

function readGitlinkOidAtHead(checkoutPath: string, pathInParent: string): string | null {
    try {
        return git(checkoutPath, "rev-parse", `HEAD:${pathInParent}`).trim();
    } catch {
        return null;
    }
}

// F10: a parent gitlink is exempt from the fence only when the child occurrence proves it, not
// merely because it is structural. Computed deepest-first, so a nested gitlink is justified by
// its own child rather than blanket-exempted, and its result feeds the next-shallower check.
function computeExemptGitlinkPaths(
    worktreePath: string,
    projectRoot: string,
    changedPathsByOccurrenceId: Map<string, string[]>,
    ownedPaths: Set<string>,
): Set<string> {
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot);
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
        // Condition 2: every non-structural child change (i.e. not already justified by this
        // same deepest-first pass) is itself inside the owned occurrence paths.
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

    const occurrences = getOccurrencesDeepestFirst(input.worktreePath, input.projectRoot, input.rootSourceBranch);
    const ownedPaths = new Set(buildOwnedOccurrencePaths(declaredFiles(input.taskNumber, input.projectRoot), occurrences));

    const changedPathsByOccurrenceId = new Map<string, string[]>();
    const allChangedPaths: string[] = [];
    for (const occurrence of occurrences) {
        const relativePaths = git(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`)
            .split("\n").filter(Boolean);
        const taggedPaths = relativePaths.map((relativePath) => buildOccurrencePath(occurrence.occurrenceId, relativePath));
        changedPathsByOccurrenceId.set(occurrence.occurrenceId, taggedPaths);
        allChangedPaths.push(...taggedPaths);
    }

    const exemptGitlinkPaths = computeExemptGitlinkPaths(input.worktreePath, input.projectRoot, changedPathsByOccurrenceId, ownedPaths);

    const violations = allChangedPaths.filter((path) => !ownedPaths.has(path) && !exemptGitlinkPaths.has(path));
    return { inside: violations.length === 0, violations };
}

if (process.argv[1]?.endsWith("checkTaskFileFence.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CheckTaskFileFenceInput;
    const output = checkTaskFileFence(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
