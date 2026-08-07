import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const taskStatsPath = fileURLToPath(new URL("./taskStats.ts", import.meta.url));

const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();

export const brief = `- stats: ${stats}

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
`;

if (process.argv[1]?.endsWith("taskStatsBrief.ts")) {
  process.stdout.write(brief);
}
