// RECORD_MERGE_COMMIT_HASHES, from pipeline-mergeSucceededExit.mmd "record the merge commit hashes to tasks.json". Mutating.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { recordMergeCommits } from "../shared/recordMergeCommits.ts";
import type { TaskCommit } from "../shared/taskRunState.ts";

export type RecordMergeCommitHashesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktree: string;
    branch: string;
    exitNote: string;
    commits: TaskCommit[];
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as RecordMergeCommitHashesInput;
    recordMergeCommits({
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, commits: packet.commits,
    });
    return {
        box: "RECORD_MERGE_COMMIT_HASHES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        worktree: packet.worktree, branch: packet.branch, exitNote: packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
