// The one WHAT TO RETURN section every prompt block ends with, keeping the answer shape in one place.
import { fileURLToPath } from "node:url";

const WRITE_AGENT_ANSWER_PATH = fileURLToPath(new URL("./writeAgentAnswer.ts", import.meta.url));

export function whatToReturnSection(value: string, explanationOfValue: string, explanationOfReturnShape: string): string {
    return `## WHAT YOU, THE SPAWNING AGENT, RETURNS

Do these three steps in order.
1. Build \`{ "message": "", "additionalData": ${value} }\`, ${explanationOfValue}.
2. Write that object into the packet file named by \`outcome.payload\` in the hook output (the same file this prompt came from) by running, with the object on stdin:
\`\`\`
node ${WRITE_AGENT_ANSWER_PATH} "<the outcome.payload path>" <<'TTANSWER'
<the object from step 1>
TTANSWER
\`\`\`
Never edit the packet file by hand; the script keeps the keys already there and fails loudly when the object is not valid JSON.
3. Only after step 2 is done, return the hook output verbatim.

If the command above could not be run at all, write that same shape anyway.
${explanationOfReturnShape}`.trimEnd();
}

// The section a spawned `claude -p` ends with; it prints JSON that the spawning agent copies into the packet.
export function printAsFinalMessageSection(value: string, explanationOfValue: string): string {
    return `## WHAT YOU PRINT

Print \`${value}\` as your final message and nothing else, ${explanationOfValue}.
The command that runs you captures that message; do not write it to a file yourself.`;
}
