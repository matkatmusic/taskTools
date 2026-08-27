// DOES_RUN_HOLD_LEASE_Q, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import type { EntryPacket } from "./_packet.ts";

// leaseReleased/leaseRetained are pre-declared false here so both arms hand the same packet shape downstream.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const owner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(packet.worktree));
    const held = owner !== null && owner.runId === packet.runId;
    if (held) {
        return { ...packet, box: "DOES_RUN_HOLD_LEASE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "RELEASE_WORKTREE_LEASE", leaseReleased: false, leaseRetained: false };
    }
    return { ...packet, box: "DOES_RUN_HOLD_LEASE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "DOES_RUN_HOLD_SOURCE_LOCK_Q", leaseReleased: false, leaseRetained: false };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
