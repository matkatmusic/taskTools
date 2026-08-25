// RECORD_MERGE_COMMIT_HASHES, from pipeline-mergeSucceededExit.mmd "record merge commit hashes to tasks.json". Mutating: appends onto tasks.json's run record.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { recordMergeCommits } from "../../tackle-tasks/recordMergeCommits.ts";
import type { TaskCommit } from "../../tackle-tasks/taskRunState.ts";

export type RecordMergeCommitHashesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktreePath: string;
    rootSourceBranch: string;
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
        worktreePath: packet.worktreePath, rootSourceBranch: packet.rootSourceBranch, exitNote: packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
