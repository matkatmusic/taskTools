// Replaces bootstrap's "prepare" mode front-end for the box before "is task number valid?".
// Mutates nothing: no worktree, no tasks.json write. See plans/tackle-tasks-v1_5-plan.md §Phase 2.
import { readFileSync } from "node:fs";
import { generateRunId } from "../prepareTasks.ts";
import { currentBranchName } from "../repositoryBranches.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type ResolveTaskRunOutput = {
    taskNumbers: number[];
    projectRoot: string;
    sourceBranch: string;
    runId: string;
};

const TASK_NUMBER_TOKEN = /^-?\d+$/;

// M2: accepted grammar is a delimiter-separated list of positive safe integers, optionally
// wrapped in one matching pair of outer brackets — "[1,2]" and "1 2" both work; "[1" and "1]"
// do not, and neither does an integer beyond Number.MAX_SAFE_INTEGER.
export function parseTaskNumberArgument(args: string): number[] {
    const trimmed = args.trim();
    const hasLeadingBracket = trimmed.startsWith("[");
    const hasTrailingBracket = trimmed.endsWith("]");
    if (hasLeadingBracket !== hasTrailingBracket) {
        throw new Error(`unmatched bracket in "${trimmed}"`);
    }
    const body = hasLeadingBracket ? trimmed.slice(1, -1) : trimmed;
    const tokens = body.trim().split(/[\s,]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) throw new Error("no task numbers given");
    const numbers: number[] = [];
    const seen = new Set<number>();
    for (const token of tokens) {
        const number = Number(token);
        if (!TASK_NUMBER_TOKEN.test(token) || !Number.isSafeInteger(number) || number <= 0) {
            throw new Error(`invalid task number "${token}"`);
        }
        if (!seen.has(number)) {
            seen.add(number);
            numbers.push(number);
        }
    }
    return numbers;
}

export function resolveTaskRun(args: string, projectRoot: string): ResolveTaskRunOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const taskNumbers = parseTaskNumberArgument(args);
    return {
        taskNumbers,
        projectRoot,
        sourceBranch: currentBranchName(projectRoot),
        runId: generateRunId(),
    };
}

if (process.argv[1]?.endsWith("resolveTaskRun.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { args: string; projectRoot: string };
    try {
        const output = resolveTaskRun(input.args, input.projectRoot);
        process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
        process.stderr.write(`resolveTaskRun: ${(error as Error).message}\n`);
        process.exit(1);
    }
}
