// WAS_LOCK_ACQUIRED_Q, from pipeline-rebasePreamble/WAS_LOCK_ACQUIRED.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

type Input = EntryPacket & { acquired: boolean; heldByOwner: string };

export function main(input: string): EntryPacket & { next: string } {
    const parsed = JSON.parse(input) as Input;
    const packet: EntryPacket = {
        box: "WAS_LOCK_ACQUIRED_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot: parsed.projectRoot,
        worktree: parsed.worktree,
        branch: parsed.branch,
        exitType: parsed.exitType,
        exitNote: parsed.exitNote,
        lockWaitStartedAt: parsed.lockWaitStartedAt,
    };
    if (parsed.acquired) {
        return { ...packet, next: "pipeline-rebase.mmd::REBASE_ONTO_TARGET_BRANCH" };
    }
    return { ...packet, next: "HAVE_15_MINUTES_PASSED_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
