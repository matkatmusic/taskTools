// TAKE_WORKTREE_LEASE, from pipeline-preambleStatusCheck.mmd. Mutating: records lease ownership in task state. "take the worktree lease for this run"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { updateCurrentTaskRun } from "../shared/taskRunState.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    updateCurrentTaskRun(packet.taskNumber, packet.runId, { worktree: packet.worktree, leaseRunId: packet.runId }, packet.projectRoot);
    return { ...packet, box: "TAKE_WORKTREE_LEASE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, docsMode: "AUTOGEN" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
