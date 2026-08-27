// LOCK_SOURCE_REPO, from pipeline-rebasePreamble/LOCK_SOURCE_REPO.ts. Tries once; WAS_LOCK_ACQUIRED_Q and the wait loop own the retry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// lockWaitStartedAt is absent on the first entry and present on the WAIT_FOR_LOCK loop-back.
type Input = Omit<EntryPacket, "lockWaitStartedAt"> & { lockWaitStartedAt?: string };

export function main(input: string): EntryPacket & { acquired: boolean; heldByOwner: string } {
    const parsed = JSON.parse(input) as Input;
    const projectRoot = requireAbsolutePath("projectRoot", parsed.projectRoot);
    // The wait clock starts once, here, so every later box in this diagram measures from the same start.
    const lockWaitStartedAt = parsed.lockWaitStartedAt ?? new Date().toISOString();
    const owner = buildLockOwner(parsed.runId, parsed.taskNumber);
    const outcome = acquireSourceRepoLock(projectRoot, owner);
    const acquired = outcome.status === "acquired" || outcome.status === "already-held-by-me";
    return {
        box: "LOCK_SOURCE_REPO",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot,
        worktree: parsed.worktree,
        branch: parsed.branch,
        exitType: parsed.exitType,
        exitNote: parsed.exitNote,
        lockWaitStartedAt,
        acquired,
        heldByOwner: "owner" in outcome ? outcome.owner : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
