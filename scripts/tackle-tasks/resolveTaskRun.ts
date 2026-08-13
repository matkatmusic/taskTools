// Replaces bootstrap's "prepare" mode front-end for the box before "is task number valid?".
// Mutates nothing: no worktree, no tasks.json write. See plans/tackle-tasks-v1_5-plan.md §Phase 2.
import { readFileSync } from "node:fs";
import { generateRunId } from "../prepareTasks.ts";
import { currentBranchName } from "../repositoryBranches.ts";

export type ResolveTaskRunOutput = {
    taskNumbers: number[];
    projectRoot: string;
    sourceBranch: string;
    runId: string;
};

const TASK_NUMBER_TOKEN = /^-?\d+$/;

export function parseTaskNumberArgument(args: string): number[] {
    const tokens = args.trim().replace(/^\[/, "").replace(/\]$/, "").split(/[\s,]+/).filter((t) => t.length > 0);
    if (tokens.length === 0) throw new Error("no task numbers given");
    const numbers: number[] = [];
    for (const token of tokens) {
        if (!TASK_NUMBER_TOKEN.test(token) || Number(token) <= 0) {
            throw new Error(`invalid task number "${token}"`);
        }
        numbers.push(Number(token));
    }
    return [...new Set(numbers)];
}

export function resolveTaskRun(args: string, projectRoot: string): ResolveTaskRunOutput {
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
