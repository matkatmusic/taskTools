// HAS_LOCK_WAIT_DEADLINE_PASSED_Q, from pipeline-rebasePreamble/HAVE_15_MINUTES_PASSED.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { EntryPacket } from "./_packet.ts";

// Covers only this box's own wait; Step 2 sizes the hook timeout around this plus the worst-case
// step that can precede LOCK_SOURCE_REPO in the same hook invocation, not around this value alone.
export const LOCK_WAIT_DEADLINE_MS = Number(process.env.LOCK_WAIT_DEADLINE_MS ?? 5 * 60 * 1000);

export function main(input: string): EntryPacket & { next: string } {
    const parsed = JSON.parse(input) as EntryPacket;
    const packet: EntryPacket = {
        box: "HAS_LOCK_WAIT_DEADLINE_PASSED_Q",
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
    const elapsedMs = Date.now() - Date.parse(parsed.lockWaitStartedAt);
    if (elapsedMs >= LOCK_WAIT_DEADLINE_MS) {
        return {
            ...packet,
            exitType: "run-failed",
            exitNote: "the source repo lock did not come free within 5 minutes",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...packet, next: "WAIT_FOR_LOCK" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
