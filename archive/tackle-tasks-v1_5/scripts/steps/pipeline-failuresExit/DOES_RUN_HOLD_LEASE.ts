// DOES_RUN_HOLD_LEASE, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & {
    publicationState: PublicationState; modifiedFiles: string[]; active: boolean; endedAt: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(packet.worktree));
    const held = owner !== null && owner.runId === packet.runId;
    const next = held ? "RELEASE_WORKTREE_LEASE" : "DOES_RUN_HOLD_SOURCE_LOCK";
    // leaseReleased/leaseRetained are pre-declared here so both arms hand the same packet shape downstream.
    return { ...packet, box: "DOES_RUN_HOLD_LEASE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next, leaseReleased: false, leaseRetained: false };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
