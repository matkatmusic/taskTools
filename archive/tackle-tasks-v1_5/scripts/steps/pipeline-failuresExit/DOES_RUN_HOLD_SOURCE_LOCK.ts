// DOES_RUN_HOLD_SOURCE_LOCK, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { buildLockOwner, readSourceRepoLock } from "../../tackle-tasks/sourceRepoLock.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & {
    publicationState: PublicationState; modifiedFiles: string[]; active: boolean; endedAt: string;
    next: string; leaseReleased: boolean; leaseRetained: boolean;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const lock = readSourceRepoLock(packet.projectRoot);
    const held = lock !== null && lock.owner === buildLockOwner(packet.runId, packet.taskNumber);
    const next = held ? "RELEASE_SOURCE_LOCK" : "REPORT_EXIT_TYPE_AND_NOTE";
    // lockReleased is pre-declared here so both arms hand the same packet shape downstream.
    return { ...packet, box: "DOES_RUN_HOLD_SOURCE_LOCK", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next, lockReleased: false };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
