// WAIT_FOR_LOCK, from pipeline-rebasePreamble/WAIT_FOR_LOCK.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

// Overridable so a test does not spend 5 real seconds per case.
const WAIT_MS = Number(process.env.WAIT_FOR_LOCK_MS ?? 5_000);
const WAIT = new Int32Array(new SharedArrayBuffer(4));

export function main(input: string): EntryPacket {
    const parsed = JSON.parse(input) as EntryPacket;
    Atomics.wait(WAIT, 0, 0, WAIT_MS);
    return {
        box: "WAIT_FOR_LOCK",
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
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
