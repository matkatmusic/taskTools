import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));

// Pre-refactor SKILL.md ran an empty `!` block here — $tasks was never assigned. Preserved as-is, see task #76.
const tasks = "";

const unblockedTaskNumbers = execSync(
  `u=$(node "${checkBlockersPath}" --unblocked '$tasks'); [ -n "$u" ] && echo "[$(echo $u | tr ' ' '\\n' | sort -n | paste -sd, -)]" || echo "none"`,
  { encoding: "utf8" },
).trimEnd();

export const brief = `- \`$tasks\`: ${tasks}
- \`$unblockedTaskNumbers\`: ${unblockedTaskNumbers}

If the line above says \`none\`, report that every open task is blocked and stop.

otherwise:
Invoke the \`tackle-tasks $unblockedTaskNumbers valid\` skill.
example: \`[30,32,35] valid\`. 
Pass it verbatim; do not re-derive or filter it.

`;

if (process.argv[1]?.endsWith("tackleUnblockedTasksBrief.ts")) {
  process.stdout.write(brief);
}
