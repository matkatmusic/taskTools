import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Tells an agent the worktree already holds work from a run that stopped; "" when this run was never resumed.
export function resumedRunSection(repoRoot: string): string {
    const path = join(repoRoot, "plans", "checkpoint.json");
    if (!existsSync(path)) return "";
    const { resumedFrom } = JSON.parse(readFileSync(path, "utf8")) as { resumedFrom: { block: string; exitType: string; exitNote: string } | null };
    if (resumedFrom === null) return "";
    const stoppedAt = resumedFrom.exitType === ""
        ? `The previous run was stopped at \`${resumedFrom.block}\`.`
        : `The previous run stopped at \`${resumedFrom.block}\` with exit type "${resumedFrom.exitType}": ${resumedFrom.exitNote}`;
    return `## RESUMED RUN

You are working in a resumed task worktree.
${stoppedAt}
The worktree already holds work from that run, and its commits are on the task branch.
Read the current state of every file you own before you change anything.
Do not redo work that is already done.`;
}
