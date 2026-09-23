// Q_COMMIT_CATCH_UP_MERGE, from pipeline-preambleStatusCheck.mmd. Commits the fixed catch-up merge; a leftover marker goes back to the fix.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { moveStagingBranchTo } from "../../shared/prepareTasks.ts";
import { CONFLICT_MARKER_LINE } from "../commitMergeConflictFixIfNeeded/COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED.ts";
import { conflictedPaths } from "../shared/FixConflictsBodyEmitter.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// repository and worktreePath come from Q_CATCH_UP_STAGING's conflict output; next is the one B_FIX_CATCH_UP_CONFLICTS inherited.
type Input = EntryPacket & { repository: string; worktreePath: string; next?: string };

export function main(input: string): EntryPacket & { next: string; repository: string; worktreePath: string } {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    const repository = requireAbsolutePath("repository", packet.repository);
    const worktreePath = requireAbsolutePath("worktreePath", packet.worktreePath);
    // runId is still "" before B_MARK_TASK_ACTIVE, so this is the owner B_LOCK_STAGING_FOR_CATCH_UP took.
    refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    const unmergedPaths = conflictedPaths(worktreePath);
    const markedPaths = unmergedPaths.filter((path) => CONFLICT_MARKER_LINE.test(readFileSync(join(worktreePath, path), "utf8")));
    // No retry limit: B_FIX_CATCH_UP_CONFLICTS asks git for the unmerged paths again on every pass.
    if (markedPaths.length > 0)
        return { ...packet, box: "Q_COMMIT_CATCH_UP_MERGE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "B_FIX_CATCH_UP_CONFLICTS" };
    // Only the unmerged paths are staged, so the untracked FIX_CATCH_UP_CONFLICTS.prompt.md stays out of the commit.
    execFileSync("git", ["-C", worktreePath, "add", "--", ...unmergedPaths], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("git", ["-C", worktreePath, "commit", "--no-edit"], { stdio: ["ignore", "ignore", "inherit"] });
    const mergeCommit = execFileSync("git", ["-C", worktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    moveStagingBranchTo(repository, mergeCommit);
    execFileSync("git", ["-C", repository, "worktree", "remove", "--force", worktreePath], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("git", ["-C", repository, "worktree", "prune"], { stdio: ["ignore", "ignore", "inherit"] });
    return { ...packet, box: "Q_COMMIT_CATCH_UP_MERGE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "Q_CATCH_UP_STAGING" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
