// DOES_RUN_HOLD_SOURCE_LOCK_Q, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import type { EntryPacket } from "./_packet.ts";

// lockReleased is pre-declared false here so both arms hand the same packet shape downstream.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const lock = readSourceRepoLock(packet.projectRoot);
    const held = lock !== null && lock.owner === buildLockOwner(packet.runId, packet.taskNumber);
    if (held) {
        return { ...packet, box: "DOES_RUN_HOLD_SOURCE_LOCK_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "RELEASE_SOURCE_LOCK", lockReleased: false };
    }
    return { ...packet, box: "DOES_RUN_HOLD_SOURCE_LOCK_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "REPORT_EXIT_TYPE_AND_NOTE", lockReleased: false };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
