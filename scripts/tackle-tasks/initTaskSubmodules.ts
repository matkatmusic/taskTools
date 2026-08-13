// "init submodules recursively" — plans/tackle-tasks-v1_5-plan.md Phase 3. Idempotent: a
// worktree already populated by createWorktreeForGroup reports initialized:false.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { initializeSubmodulesInWorktree } from "../prepareTasks.ts";
import {
    SUBMODULES_INITIALIZED, SUBMODULES_NOT_INITIALIZED, type SubmoduleInitializationState,
} from "./reconciliationOutcomes.ts";

function git(worktreePath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" });
}

export type InitTaskSubmodulesOutput = { initialized: SubmoduleInitializationState };

export function initTaskSubmodules(worktreePath: string): InitTaskSubmodulesOutput {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return { initialized: SUBMODULES_NOT_INITIALIZED };
    const status = git(worktreePath, "submodule", "status");
    const wasUninitialized = status.split("\n").some((line) => line.startsWith("-"));
    initializeSubmodulesInWorktree(worktreePath);
    return { initialized: wasUninitialized ? SUBMODULES_INITIALIZED : SUBMODULES_NOT_INITIALIZED };
}

export type InitTaskSubmodulesCliInput = { worktreePath: string };

if (process.argv[1]?.endsWith("initTaskSubmodules.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as InitTaskSubmodulesCliInput;
    const output = initTaskSubmodules(input.worktreePath);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
