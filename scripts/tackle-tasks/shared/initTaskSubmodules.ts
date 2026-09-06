// "init submodules recursively" — plans/tackle-tasks-v1_5-plan.md Phase 3. Idempotent: a
// worktree already populated by createWorktreeForGroup reports initialized:false.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeSubmodulesInWorktree } from "../../shared/prepareTasks.ts";
import { appendStepResult } from "./taskRunState.ts";

function git(worktreePath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
}

export type InitTaskSubmodulesInput = {
    worktreePath: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    stepId: string;
};

export type InitTaskSubmodulesOutput = { initialized: boolean };

// F10: persists the exact returned result onto the run before returning it, so a lost stdout can
// be reconstructed exactly rather than reconciliation guessing at an "unknown" state.
export function initTaskSubmodules(input: InitTaskSubmodulesInput): InitTaskSubmodulesOutput {
    const { worktreePath, taskNumber, runId, projectRoot, stepId } = input;
    let result: InitTaskSubmodulesOutput;
    if (!existsSync(join(worktreePath, ".gitmodules"))) {
        result = { initialized: false };
    } else {
        const status = git(worktreePath, "submodule", "status");
        const wasUninitialized = status.split("\n").some((line) => line.startsWith("-"));
        initializeSubmodulesInWorktree(worktreePath);
        result = { initialized: wasUninitialized };
    }
    appendStepResult(taskNumber, runId, { stepId, script: "initTaskSubmodules", result }, projectRoot);
    return result;
}

// CLI entrypoint migrated to scripts/steps/pipeline-worktreeCheck/INIT_SUBMODULES_RECURSIVELY.ts.
// if (process.argv[1]?.endsWith("initTaskSubmodules.ts")) {
//     const input = JSON.parse(readFileSync(0, "utf8")) as InitTaskSubmodulesInput;
//     const output = initTaskSubmodules(input);
//     process.stdout.write(`${JSON.stringify(output)}\n`);
// }
