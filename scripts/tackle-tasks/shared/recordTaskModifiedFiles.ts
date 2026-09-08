// "record modified files to tasks.json" — pipeline.mmd, run before clean-up on both chains.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildOccurrencePath, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { updateCurrentTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type RecordTaskModifiedFilesInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string | null;
    sourceBranch: string;
};

export type RecordTaskModifiedFilesOutput = { modifiedFiles: string[] };

function diffChangedPaths(checkoutPath: string, baseRef: string): string[] {
    return execFileSync("git", ["-C", checkoutPath, "diff", "--name-only", `${baseRef}...HEAD`], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
}

// No worktree is a valid input (the `blocked` exit fires before one exists, and the
// recovery chain can run after clean-up already deleted one): report [] and leave any
// existing non-empty record untouched, never overwrite it with an empty one.
export function recordTaskModifiedFiles(input: RecordTaskModifiedFilesInput): RecordTaskModifiedFilesOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    if (input.worktree === null) {
        return { modifiedFiles: [] };
    }
    requireAbsolutePath("worktree", input.worktree);
    if (!existsSync(input.worktree)) {
        return { modifiedFiles: [] };
    }
    const occurrences = getOccurrencesDeepestFirst(input.worktree, input.projectRoot, input.sourceBranch);
    const modifiedFiles = occurrences.flatMap((occurrence) =>
        diffChangedPaths(occurrence.checkoutPath, occurrence.baseRef)
            .map((relativePath) => buildOccurrencePath(occurrence.occurrenceId, relativePath)));
    updateCurrentTaskRun(input.taskNumber, input.runId, { modifiedFiles }, input.projectRoot);
    return { modifiedFiles };
}

if (process.argv[1]?.endsWith("recordTaskModifiedFiles.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RecordTaskModifiedFilesInput;
    const output = recordTaskModifiedFiles(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
