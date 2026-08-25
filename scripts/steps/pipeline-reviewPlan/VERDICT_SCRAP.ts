// VERDICT_SCRAP, from pipeline-reviewPlan.mmd. Codex wants the plan rewritten and re-reviewed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type VerdictScrapPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    notes: string;
    runId: string;
    sourceBranch: string;
    // plan: unknown;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as VerdictScrapPacket;
    return {
        box: "VERDICT_SCRAP",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        notes: packet.notes,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        // plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
