// "record merge commit hashes to tasks.json" (pipeline.mmd). Appends the merge box's commits
// onto the run record - never overwrites, since it already holds this run's work/repair commits.
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { appendTaskCommits, type TaskCommit } from "./taskRunState.ts";

export type RecordMergeCommitsInput = {
    projectRoot: string;
    taskNumber: number;
    runId: string;
    commits: TaskCommit[];
};

export type RecordMergeCommitsOutput = { commits: TaskCommit[] };

export function recordMergeCommits(input: RecordMergeCommitsInput): RecordMergeCommitsOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

    appendTaskCommits(input.taskNumber, input.runId, input.commits, projectRoot);
    return { commits: input.commits };
}

if (process.argv[1]?.endsWith("recordMergeCommits.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RecordMergeCommitsInput;
    const output = recordMergeCommits(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
