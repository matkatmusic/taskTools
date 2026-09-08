// LOCK_SOURCE_REPO, from pipeline-rebasePreamble.mmd Tries once; WAS_LOCK_ACQUIRED and the wait loop own the retry, not this box.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../../tackle-tasks/sourceRepoLock.ts";

export type LockSourceRepoBoxInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
    lockWaitStartedAt: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as LockSourceRepoBoxInput;
    const projectRoot = requireAbsolutePath("projectRoot", parsed.projectRoot);
    // The owner is runId:taskNumber, and re-acquiring as the same owner is a no-op.
    const owner = buildLockOwner(parsed.runId, parsed.taskNumber);
    const outcome = acquireSourceRepoLock(projectRoot, owner);
    const acquired = outcome.status === "acquired" || outcome.status === "already-held-by-me";
    return {
        box: "LOCK_SOURCE_REPO",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        lockWaitStartedAt: parsed.lockWaitStartedAt,
        acquired,
        heldByOwner: "owner" in outcome ? outcome.owner : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
