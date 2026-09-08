// TAKE_WORKTREE_LEASE_BEFORE_RESET, from pipeline-preambleStatusCheck.mmd. Mutating: releases or adopts the worktree's lease before RESET_WORKTREE tears it down.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { releaseTaskWorktreeLease } from "../../shared/prepareTasks.ts";
import { readTaskRunState, transitionWorktreeLease } from "../shared/taskRunState.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const outcome = transitionWorktreeLease(packet.taskNumber, packet.runId, packet.projectRoot);
    if (outcome.status === "refused-owner-mismatch") {
        throw new Error(`worktree lease for task ${packet.taskNumber} is held by run "${outcome.heldByRunId}", refusing reset`);
    }
    const state = readTaskRunState(packet.taskNumber, packet.projectRoot);
    if (outcome.status === "adopted" && state.worktree !== null) {
        releaseTaskWorktreeLease({ worktreePath: state.worktree, runId: packet.runId });
    }
    return { ...packet, box: "TAKE_WORKTREE_LEASE_BEFORE_RESET", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
