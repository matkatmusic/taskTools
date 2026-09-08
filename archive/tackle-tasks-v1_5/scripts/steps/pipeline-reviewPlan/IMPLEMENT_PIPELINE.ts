// IMPLEMENT_PIPELINE, from pipeline-reviewPlan.mmd. Forwards the accepted plan to pipeline-implement.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

// maxFixRounds was always this fallback pre-migration too (scripts/tackle-tasks/AgentPromptEmitter.ts:193).
const DEFAULT_MAX_FIX_ROUNDS = 3;

export type ImplementPipelinePacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    planFile: string;
    runId: string;
    sourceBranch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ImplementPipelinePacket;
    // typecheckCommand is not carried by this chain; left unset so the strict entry throws, not guesses.
    return {
        box: "IMPLEMENT_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        projectRoot: packet.taskStateRoot,
        worktreePath: packet.repoRoot,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
