// B_LOCK_STAGING_FOR_CATCH_UP, from pipeline-preambleStatusCheck.mmd. Copy of lockSourceRepo/LOCK_SOURCE_REPO.ts. Tries once; the wait loop owns the retry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { acquireSourceRepoLock, buildLockOwner } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// lockWaitStartedAt is absent on the first entry and present on the B_WAIT_FOR_CATCH_UP_LOCK loop-back.
type Input = EntryPacket & { lockWaitStartedAt?: string; next?: string };

export function main(input: string): EntryPacket & { lockWaitStartedAt: string; acquired: boolean; heldByOwner: string } {
    const { next: _next, ...packet } = JSON.parse(input) as Input;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    // The wait clock starts once, here, so every later box in this loop measures from the same start.
    const lockWaitStartedAt = packet.lockWaitStartedAt ?? new Date().toISOString();
    const owner = buildLockOwner(packet.runId, packet.taskNumber);
    const outcome = acquireSourceRepoLock(projectRoot, owner);
    const acquired = outcome.status === "acquired" || outcome.status === "already-held-by-me";
    return {
        ...packet,
        box: "B_LOCK_STAGING_FOR_CATCH_UP",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot,
        lockWaitStartedAt,
        acquired,
        heldByOwner: "owner" in outcome ? outcome.owner : "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
