import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const checkBlockersPath = fileURLToPath(new URL("../shared/checkBlockers.ts", import.meta.url));

// Pre-refactor SKILL.md ran an empty `!` block here — $tasks was never assigned. Preserved as-is, see task #76.
const tasks = "";

const unblockedTaskNumbers = execSync(
  `u=$(node "${checkBlockersPath}" --unblocked '$tasks'); [ -n "$u" ] && echo "[$(echo $u | tr ' ' '\\n' | sort -n | paste -sd, -)]" || echo "none"`,
  { encoding: "utf8" },
).trimEnd();

export const brief = `- \`$tasks\`: ${tasks}
- \`$unblockedTaskNumbers\`: ${unblockedTaskNumbers}

Loop through every task in tasks.json until it contains no more entries. For each task found that is unblocked, spawn the workflow pipeline to complete the task:
1. Run \`node "${checkBlockersPath}" --unblocked\` to get the unblocked task numbers.
2. If tasks.json has no entries, report that and stop.
3. If no numbers come back, report that every open task is blocked and stop.
4. Invoke the \`tackle-tasks [the numbers just returned]\` skill. Pass the list verbatim; do not re-derive or filter it. Wait for every launched run's completion notification. The notification, not polling, is how you learn a run is done.
5. Go back to step 1.

`;

if (process.argv[1]?.endsWith("tackleUnblockedTasksBrief.ts")) {
  process.stdout.write(brief);
}
