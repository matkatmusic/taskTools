// Run-scoped recovery snapshots under refs/recovery/..., without moving any branch or touching the real index.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readDirectGitlinks } from "./gitlinkReader.ts";
import { substituteGitlink } from "./repositoryIntegration.ts";

export type RecoverySnapshotKind = "worker" | "sync";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

export function recoveryRefName(runId: string, kind: RecoverySnapshotKind, snapshotId: string): string {
    return `refs/recovery/${runId}/${kind}/${snapshotId}`;
}

function resolveGitDir(repoPath: string): string {
    const gitDir = git(repoPath, "rev-parse", "--git-dir").trim();
    return isAbsolute(gitDir) ? gitDir : join(repoPath, gitDir);
}

// Throwaway index via GIT_INDEX_FILE so write-tree sees uncommitted changes, real index untouched.
function snapshotWorkingTreeToTree(repoPath: string): string {
    const indexPath = join(resolveGitDir(repoPath), `recovery-${randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
        execFileSync("git", ["-C", repoPath, "add", "-A"], { env });
        return execFileSync("git", ["-C", repoPath, "write-tree"], { encoding: "utf8", env }).trim();
    } finally {
        rmSync(indexPath, { force: true });
    }
}

// Snapshots repoPath, then substitutes each direct gitlink with a recursive snapshot of its own state.
function snapshotRepoRecursively(repoPath: string, message: string): string {
    const rawTreeSha = snapshotWorkingTreeToTree(repoPath);
    let commitSha = git(repoPath, "commit-tree", rawTreeSha, "-m", message).trim();
    for (const entry of readDirectGitlinks(repoPath, rawTreeSha)) {
        const nestedCommitSha = snapshotRepoRecursively(join(repoPath, entry.path), message);
        commitSha = substituteGitlink(repoPath, {
            parentCommitOid: commitSha,
            pathInParent: entry.path,
            childOid: nestedCommitSha,
        });
    }
    return commitSha;
}

function writeRecoverySnapshot(
    repoPath: string,
    runId: string,
    kind: RecoverySnapshotKind,
    snapshotId: string,
): Promise<string> {
    const commitSha = snapshotRepoRecursively(repoPath, `recovery: ${kind} ${snapshotId} (${runId})`);
    git(repoPath, "update-ref", recoveryRefName(runId, kind, snapshotId), commitSha);
    return Promise.resolve(commitSha);
}

export function snapshotWorkerRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string> {
    return writeRecoverySnapshot(repoPath, runId, "worker", snapshotId);
}

export function snapshotSyncRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string> {
    return writeRecoverySnapshot(repoPath, runId, "sync", snapshotId);
}
