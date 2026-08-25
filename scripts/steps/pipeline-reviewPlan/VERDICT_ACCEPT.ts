// VERDICT_ACCEPT, from pipeline-reviewPlan.mmd. Codex accepted the plan as is; forwards to implement.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type VerdictAcceptPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    planFile: string;
    runId: string;
    sourceBranch: string;
    plan: unknown;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as VerdictAcceptPacket;
    return {
        box: "VERDICT_ACCEPT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        planFile: packet.planFile,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
