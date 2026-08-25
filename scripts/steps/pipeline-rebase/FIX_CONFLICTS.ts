// FIX_CONFLICTS, from pipeline-rebase.mmd. Reuses fixConflictsPrompt, the sole home of this prompt's text.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { fixConflictsPrompt } from "../../tackle-tasks/FixConflictsBodyEmitter.ts";
import { refreshLockHeartbeat, type RebasePacket } from "./packet.ts";

export function main(input: string): { box: string; scriptSignal: string; prompt: string } {
    const packet = JSON.parse(input) as RebasePacket;
    refreshLockHeartbeat(packet.projectRoot, packet.runId, packet.taskNumber);
    const promptFile = `${packet.worktreePath.replace(/\/+$/, "")}/plans/FIX_CONFLICTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, fixConflictsPrompt(packet.stoppedCheckoutPath, packet.taskNumber, packet.projectRoot, packet.runId, packet.rootSourceBranch));
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "FIX_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
