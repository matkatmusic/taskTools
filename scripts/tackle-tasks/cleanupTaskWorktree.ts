// "clean up worktrees, leases, persistence refs and source lock" (pipeline.mmd). Order matters:
// this is the fix for a stranding bug - ownership (lease, then lock) is released LAST, only
// after the destructive removal has actually succeeded. A failed removal keeps both, so no
// other process can take a worktree that still holds retained work.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildLockOwner, refreshSourceRepoLock, releaseSourceRepoLock } from "./sourceRepoLock.ts";
import { GENERATED_ARTIFACT_PATTERNS } from "./writeTaskBrief.ts";
import { loadRepositoryManifest, releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../prepareTasks.ts";
import {
    collectRetainedTaskArtifacts, deleteTaskMergePersistence, removeTaskWorktreeAndBranches,
    type SourceBranchCleanupTarget,
} from "../mergeTaskWorktrees.ts";

export type CleanupTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    branchName: string;
};

export type CleanupTaskWorktreeOutput = { removed: boolean; retainedArtifacts: string[] };

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
}

// Step 1: delete generated docs from disk. No git rm, no commit - they were never committed.
function deleteGeneratedDocs(worktreePath: string): void {
    const plansDir = join(worktreePath, "plans");
    if (!existsSync(plansDir)) return;
    const filenamePatterns = GENERATED_ARTIFACT_PATTERNS.map((pattern) => globToRegExp(pattern.replace(/^plans\//, "")));
    for (const entry of readdirSync(plansDir)) {
        if (filenamePatterns.some((pattern) => pattern.test(entry))) rmSync(join(plansDir, entry), { force: true });
    }
}

// Step 2: deleteTaskMergePersistence for every source occurrence, not just the root.
function deleteMergePersistenceEverywhere(projectRoot: string, branchName: string): SourceBranchCleanupTarget[] {
    const manifest = loadRepositoryManifest(projectRoot);
    const deepestFirst = [...manifest.occurrences].sort((a, b) => b.depth - a.depth);
    for (const occurrence of deepestFirst) deleteTaskMergePersistence(occurrence.checkoutPath, branchName);
    return manifest.occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }));
}

export function cleanupTaskWorktree(input: CleanupTaskWorktreeInput): CleanupTaskWorktreeOutput {
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshSourceRepoLock(input.projectRoot, owner);

    deleteGeneratedDocs(input.worktreePath);
    const sourceSubmodules = deleteMergePersistenceEverywhere(input.projectRoot, input.branchName);

    const leasePath = taskWorktreeLeasePath(input.worktreePath);
    const retainedArtifactTarget = {
        worktreePath: input.worktreePath, leasePath, mainRepoRoot: input.projectRoot, branch: input.branchName, sourceSubmodules,
    };

    // Step 3: remove the worktree and its branches. A failure here must not release ownership.
    try {
        removeTaskWorktreeAndBranches(input.projectRoot, input.worktreePath, input.branchName, sourceSubmodules);
    } catch {
        return { removed: false, retainedArtifacts: collectRetainedTaskArtifacts(retainedArtifactTarget) };
    }

    // Step 4: release the worktree lease.
    releaseTaskWorktreeLease({ worktreePath: input.worktreePath, runId: input.runId });
    // Step 5: release the source lock, last.
    releaseSourceRepoLock(input.projectRoot, owner);

    return { removed: true, retainedArtifacts: collectRetainedTaskArtifacts(retainedArtifactTarget) };
}

if (process.argv[1]?.endsWith("cleanupTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CleanupTaskWorktreeInput;
    const output = cleanupTaskWorktree(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
