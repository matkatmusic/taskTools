// CODEX_REVIEWS_PLAN, from pipeline-reviewPlan.mmd. Spawns a review agent; the next diagram reads and rules on the file it writes.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import { reviewQuestion } from "../shared/CodexReviewBodyEmitter.ts";
import { loadPreparedTask, type PreparedTask } from "../shared/preparedTask.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";

const REVIEW_PLAN_SCHEMA_PATH = fileURLToPath(new URL("../../../plans/review-plan-schema.json", import.meta.url));

function planReviewPrompt(t: PreparedTask): string {
    return `You are spawning a review agent running in the CLI.
You do not edit any files; your job is to run the following command, and return exactly what was printed, in a specific JSON shape.
The command runs a reviewing agent against a plan file.

## THE COMMAND

Run the following multi-line command using Bash(), verbatim, as one single call. It takes a few
minutes; wait for it rather than abandoning it. \`</dev/null\` matters — codex hangs forever
waiting on stdin without it. \`-o\` keeps codex from mixing its banner into the answer, and \`--output-schema\` makes it bare JSON.

\`\`\`\`sh
REVIEW_PROMPT=$(cat <<'REVIEWEOF'
${reviewQuestion(t)}
REVIEWEOF
)
REVIEW_FILE=${t.reviewOutputFile}
codex exec -s read-only --output-schema ${REVIEW_PLAN_SCHEMA_PATH} -o "$REVIEW_FILE" "$REVIEW_PROMPT" </dev/null >/dev/null \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model fable --effort medium </dev/null >"$REVIEW_FILE" \\
  || claude -p "$REVIEW_PROMPT" --tools "Read" --model claude-opus-4-8 --effort high </dev/null >"$REVIEW_FILE"
\`\`\`\`

${whatToReturnSection(`{ "reviewFile": "${t.reviewOutputFile}" }`, "the path \\`$REVIEW_FILE\\` was set to, never its contents", "The next block reads the file and fails loudly when it is missing or unusable.")}
`;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const t = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    return { box: "CODEX_REVIEWS_PLAN", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt: planReviewPrompt(t) };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
