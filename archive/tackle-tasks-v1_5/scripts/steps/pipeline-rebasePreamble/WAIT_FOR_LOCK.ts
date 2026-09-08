// WAIT_FOR_LOCK, from pipeline-rebasePreamble.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type WaitForLockInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
    lockWaitStartedAt: string;
};

// Overridable so a test does not spend 5 real seconds per case.
const WAIT_MS = Number(process.env.WAIT_FOR_LOCK_MS ?? 5_000);
const WAIT = new Int32Array(new SharedArrayBuffer(4));

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as WaitForLockInput;
    Atomics.wait(WAIT, 0, 0, WAIT_MS);
    return {
        box: "WAIT_FOR_LOCK",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot: parsed.projectRoot,
        worktreePath: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        lockWaitStartedAt: parsed.lockWaitStartedAt,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
