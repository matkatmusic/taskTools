// "clean up worktrees, leases, persistence refs and source lock" (pipeline.mmd). Order matters: this is the fix for a stranding bug - ownership (lease, then lock) is released LAST, only after the destructive removal has actually succeeded. A failed removal keeps both, so no other process can take a worktree that still holds retained work.  F5: removal failure is an operational failure, not a verdict - it throws (never returns removed:false) so the CLI exits non-zero and rule 10's exit chain runs. Lease policy: the worktree lease is retained for as long as any retained artifact (worktree or task branch) still exists; the source lock is always released so unrelated tasks can proceed. This is derived from an ownership-checked retained-artifact query, not a caller-supplied flag - the query is authoritative and cannot be defeated by a wrong caller input.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow, releaseSourceRepoLock } from "./sourceRepoLock.ts";
import { taskBranchName } from "./createTaskWorktree.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { GENERATED_ARTIFACT_PATTERNS } from "./writeTaskBrief.ts";
import { loadRepositoryManifest, releaseTaskWorktreeLease, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import {
    collectRetainedTaskArtifacts, deleteTaskMergePersistence, removeTaskWorktreeAndBranches,
    type RetainedArtifactTarget, type SourceBranchCleanupTarget,
} from "../../mergeTaskWorktrees.ts";

// M3: branchName is derived from taskNumber inside this script, never accepted independently on stdin - a malformed payload can no longer point cleanup's destructive branch/ref deletions at another task.
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

    const manifest = loadRepositoryManifest(input.projectRoot, input.rootSourceBranch);
    const sourceSubmodules: SourceBranchCleanupTarget[] = manifest.occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }));
    const retainedArtifactTarget = buildRetainedArtifactTarget(input, branchName, sourceSubmodules);

    // F2 exception: an idempotent reconciliation may return success without the lock, but only after proving the worktree, task branches, persistence refs and owned lease are ALL absent. A missing lock alone is not proof of completion; a still-existing artifact means real work remains, so we fall through and require the lock like any other mutation.
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
        // Always release the source lock so unrelated tasks can still run. Never release the worktree lease here: retainedArtifacts is non-empty by construction (removal failed), so it still needs a live ownership marker for the next claimed run to adopt.
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
