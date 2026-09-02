// FIX_CONFLICTS, from pipeline-rebase.mmd. Reuses fixConflictsPrompt, the sole home of this prompt's text.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { fixConflictsPrompt } from "../shared/FixConflictsBodyEmitter.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import type { FixConflictsPacket } from "./_packet.ts";

// Beside the run-log, so `tail -f` on it shows the spawned agent working. The hook sets RUN_STEP_LOG for every block.
// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as FixConflictsPacket;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktree = requireAbsolutePath("worktree", packet.worktree);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
    // const rootSourceBranch = execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const rootSourceBranch = "staging";
    const promptFile = `${worktree.replace(/\/+$/, "")}/plans/FIX_CONFLICTS.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, fixConflictsPrompt(worktree, packet.taskNumber, projectRoot, packet.runId, rootSourceBranch));
    // const answerFile = `${worktree.replace(/\/+$/, "")}/plans/FIX_CONFLICTS.answer.json`;
    // const prompt = `You are spawning an agent running in the CLI.
    // You do not edit any files; your job is to run the following command, and copy what the agent printed into the packet.
    //
    // ## THE COMMAND
    //
    // Run the following multi-line command using Bash(), verbatim, as one single call. It can take many minutes; wait for it rather than abandoning it. `</dev/null` matters — claude hangs waiting on stdin without it.
    //
    // ````sh
    // PROMPT_FILE=${promptFile}
    // ANSWER_FILE=${answerFile}
    // AGENT_LOG=${agentLogFile()}
    // cd ${worktree} && claude -p "$(cat "$PROMPT_FILE")" \\
    //   --output-format stream-json --verbose \\
    //   --dangerously-skip-permissions \\
    //   </dev/null >>"$AGENT_LOG" 2>&1
    // jq -r 'select(.type=="result") | .result' "$AGENT_LOG" | tail -1 > "$ANSWER_FILE"
    // cat "$ANSWER_FILE"
    // ````
    //
    // ${whatToReturnSection('{ "resolved": "<true only when every listed path has no conflict marker left. false otherwise.>", "unresolvedPaths": ["<absolute path of a file that still contains a conflict marker. Empty array when resolved is true.>"] }', 'copied from what `cat "$ANSWER_FILE"` printed', "")}`;
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "FIX_CONFLICTS", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
