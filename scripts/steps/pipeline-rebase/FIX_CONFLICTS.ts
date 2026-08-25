// FIX_CONFLICTS, from pipeline-rebase.mmd. Prompt block: reuses fixConflictsPrompt, the sole
// home of this prompt's text (still imported by AgentPromptEmitter.ts's old dispatch too).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { fixConflictsPrompt } from "../../tackle-tasks/FixConflictsBodyEmitter.ts";
import { refreshLockHeartbeat, type RebasePacket } from "./packet.ts";

export function main(input: string): { box: string; scriptSignal: string; prompt: string } {
    const packet = JSON.parse(input) as RebasePacket;
    refreshLockHeartbeat(packet.projectRoot, packet.runId, packet.taskNumber);
    const prompt = fixConflictsPrompt(packet.stoppedCheckoutPath, packet.taskNumber, packet.projectRoot, packet.runId, packet.rootSourceBranch);
    return { box: "FIX_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
