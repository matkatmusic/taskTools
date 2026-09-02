// Commands that spawn a CLI agent: `claude -p` for agent blocks, `codex exec` for reviews.
import { whatToReturnSection } from "./whatToReturn.ts";

// Logs beside the run-log so `tail -f` shows the agent working; the hook sets RUN_STEP_LOG.
const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.json$/, "-agents.log");

// Expects the caller's shell to have set REVIEW_PROMPT, REVIEW_FILE and CODEX_LOG.
export function codexExecCommand(schemaPath: string): string {
    return `perl -e 'alarm shift; exec @ARGV' 300 \\
  codex exec \\
    -m gpt-5.6-terra -c 'model_reasoning_effort="medium"' \\
    -s read-only \\
    --output-schema ${schemaPath} \\
    -o "$REVIEW_FILE" \\
    "$REVIEW_PROMPT" \\
    </dev/null >/dev/null 2>>"$CODEX_LOG"`;
}

// Read-only review fallbacks; expect the caller's shell to have set REVIEW_PROMPT and REVIEW_FILE.
export function spawnClaudeFableCli(effort: string): string {
    return `claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort ${effort} </dev/null >"$REVIEW_FILE"`;
}

export function spawnClaudeOpus48Cli(effort: string): string {
    return `claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort ${effort} </dev/null >"$REVIEW_FILE"`;
}

// Expects the caller's shell to have set PROMPT_FILE and AGENT_LOG.
export function claudeCliCommand(): string {
    return `claude -p "$(cat "$PROMPT_FILE")" \\
  --output-format stream-json --verbose \\
  --permission-mode acceptEdits --allowedTools "Bash(node *)" "Bash(git *)" \\
  </dev/null >>"$AGENT_LOG"`;
}

// The header every spawning prompt starts with; the sh block that runs the agent follows it.
export function spawnAgentHeader(agentType: string, isCodex: boolean): string {
    const codexSentence = " `</dev/null` matters — codex hangs forever waiting on stdin without it. `-o` keeps codex from mixing its banner into the answer, and `--output-schema` makes it bare JSON.";
    return `You are spawning a ${agentType} agent running in the CLI.
You do not edit any files. Your job is to run the following command. The command runs a ${agentType} agent.

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call. It can take many minutes; wait for it rather than abandoning it.${isCodex ? codexSentence : ""}`;
}

export function spawnClaudeCliPrompt(box: string, worktree: string, promptFile: string, value: string): string {
    const root = worktree.replace(/\/+$/, "");
    const answerFile = `${root}/plans/${box}.answer.json`;
    return `${spawnAgentHeader("claude", false)}

\`\`\`\`sh
PROMPT_FILE=${promptFile}
ANSWER_FILE=${answerFile}
AGENT_LOG=${agentLogFile()}
cd ${root} && ${claudeCliCommand()}
jq -r 'select(.type=="result") | .result' "$AGENT_LOG" | tail -1 > "$ANSWER_FILE"
cat "$ANSWER_FILE"
\`\`\`\`

${whatToReturnSection(value, 'copied from what `cat "$ANSWER_FILE"` printed', "")}`;
}
