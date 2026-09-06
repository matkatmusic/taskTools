// Cleans up worktrees, leases, refs and lock (pipeline.mmd); releases ownership last, after removal succeeds, so no process strands work.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow, releaseSourceRepoLock } from "./sourceRepoLock.ts";
import { taskBranchName } from "./createTaskWorktree.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { GENERATED_ARTIFACT_PATTERNS } from "./writeTaskBrief.ts";
import { releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../../shared/prepareTasks.ts";
import {
    collectRetainedTaskArtifacts, deleteTaskMergePersistence, removeTaskWorktreeAndBranches,
    type RetainedArtifactTarget, type SourceBranchCleanupTarget,
} from "../../merge-worktree-tasks/mergeTaskWorktrees.ts";
import { loadSourceManifest } from "./occurrences.ts";

// M3: branchName derives from taskNumber here, not stdin, so a malformed payload can't target another task's deletions.
export type CleanupTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    rootSourceBranch: string;
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

function buildRetainedArtifactTarget(
    input: CleanupTaskWorktreeInput,
    branchName: string,
    sourceSubmodules: SourceBranchCleanupTarget[],
): RetainedArtifactTarget {
    return {
        worktreePath: input.worktreePath,
        leasePath: taskWorktreeLeasePath(input.worktreePath),
        mainRepoRoot: input.projectRoot,
        branch: branchName,
        sourceSubmodules,
    };
}

export function cleanupTaskWorktree(input: CleanupTaskWorktreeInput): CleanupTaskWorktreeOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    requireAbsolutePath("worktreePath", input.worktreePath);

    const branchName = taskBranchName(input.taskNumber);
    const owner = buildLockOwner(input.runId, input.taskNumber);

    const manifest = loadSourceManifest(input.projectRoot, input.rootSourceBranch);
    const sourceSubmodules: SourceBranchCleanupTarget[] = manifest.occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }));
    const retainedArtifactTarget = buildRetainedArtifactTarget(input, branchName, sourceSubmodules);

    // F2: skip the lock if worktree, branches, refs, and lease are ALL absent; any remaining artifact requires the lock.
    if (collectRetainedTaskArtifacts(retainedArtifactTarget).length === 0) {
        return { removed: true, retainedArtifacts: [] };
    }

    refreshOwnedSourceRepoLockOrThrow(input.projectRoot, owner);

    try {
        deleteGeneratedDocs(input.worktreePath);
        // Step 2: deleteTaskMergePersistence for every source occurrence, not just the root.
        const deepestFirst = [...manifest.occurrences].sort((a, b) => b.depth - a.depth);
        for (const occurrence of deepestFirst) deleteTaskMergePersistence(occurrence.checkoutPath, branchName);
        // Step 3: remove the worktree and its branches.
        removeTaskWorktreeAndBranches(input.projectRoot, input.worktreePath, branchName, sourceSubmodules);
    } catch (cleanupError) {
        const retainedArtifacts = collectRetainedTaskArtifacts(retainedArtifactTarget);
        // Always release the source lock; keep the worktree lease, since retainedArtifacts is non-empty, so future runs can adopt it.
        releaseSourceRepoLock(input.projectRoot, owner);
        throw new Error(
            `cleanup failed to remove task ${input.taskNumber}'s worktree/branches: `
            + `${(cleanupError as Error).message}. retained artifacts: `
            + `${retainedArtifacts.length > 0 ? retainedArtifacts.join(", ") : "(none)"}`,
        );
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
