// RESUME_PREVIOUS_RUN_IF_POSSIBLE, from pipeline-preambleStatusCheck.mmd. Mutating: adopts or takes the worktree lease.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { establishTaskRunLease } from "../shared/isTaskRunResumable.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const leaseEstablished = establishTaskRunLease(packet.taskNumber, packet.runId, packet.projectRoot);
    if (leaseEstablished) {
        return { ...packet, box: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "Q_PREVIOUS_RUN_LEFT_NOTES" };
    }
    return {
        ...packet,
        box: "Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: "already-running",
        exitNote: "this task is already running through the pipeline",
        next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
