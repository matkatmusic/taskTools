// RELEASE_SOURCE_LOCK, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { buildLockOwner, releaseSourceRepoLock } from "../../tackle-tasks/sourceRepoLock.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & {
    publicationState: PublicationState; modifiedFiles: string[]; active: boolean; endedAt: string;
    next: string; leaseReleased: boolean; leaseRetained: boolean; lockReleased: boolean;
};

export function main(input: string): Record<string, unknown> {
    const { next: _next, lockReleased: _lockReleased, ...packet } = JSON.parse(input) as Input;
    const { released } = releaseSourceRepoLock(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    return { ...packet, box: "RELEASE_SOURCE_LOCK", scriptSignal: SCRIPT_SIGNAL.CONTINUE, lockReleased: released };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
