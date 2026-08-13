// "did every change stay inside the task's owned files?" (pipeline.mmd). Computes the diff
// itself, deepest-first over every occurrence; never trusts a self-reported changedPaths.
// Both the diff and task.files go through buildOccurrencePath/buildOwnedOccurrencePaths so the
// two namespaces are comparable. A violation always exits; there is no in-run widening.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshSourceRepoLock } from "./sourceRepoLock.ts";
import { buildDiscoveryManifest, buildOccurrencePath, buildOwnedOccurrencePaths, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";

// A submodule gitlink bump in its parent is mechanical bookkeeping (rule 8's commit walk),
// never a choice the agent made - so it is always in-fence, regardless of task.files.
function structuralGitlinkPaths(worktreePath: string, projectRoot: string): Set<string> {
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot);
    return new Set(
        manifest.repositoryManifest.occurrences
            .filter((occurrence) => occurrence.parentOccurrenceId !== null && occurrence.pathInParent !== null)
            .map((occurrence) => buildOccurrencePath(occurrence.parentOccurrenceId as string, occurrence.pathInParent as string)),
    );
}

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

export function checkTaskFileFence(input: CheckTaskFileFenceInput): CheckTaskFileFenceOutput {
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshSourceRepoLock(input.projectRoot, owner);

    const occurrences = getOccurrencesDeepestFirst(input.worktreePath, input.projectRoot, input.rootSourceBranch);
    const ownedPaths = new Set(buildOwnedOccurrencePaths(declaredFiles(input.taskNumber, input.projectRoot), occurrences));
    const structuralPaths = structuralGitlinkPaths(input.worktreePath, input.projectRoot);

    const changedPaths: string[] = [];
    for (const occurrence of occurrences) {
        const relativePaths = git(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`)
            .split("\n").filter(Boolean);
        for (const relativePath of relativePaths) changedPaths.push(buildOccurrencePath(occurrence.occurrenceId, relativePath));
    }

    const violations = changedPaths.filter((path) => !ownedPaths.has(path) && !structuralPaths.has(path));
    return { inside: violations.length === 0, violations };
}

if (process.argv[1]?.endsWith("checkTaskFileFence.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CheckTaskFileFenceInput;
    const output = checkTaskFileFence(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
