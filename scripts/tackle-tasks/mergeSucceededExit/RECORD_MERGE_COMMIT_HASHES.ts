// RECORD_MERGE_COMMIT_HASHES, from pipeline-mergeSucceededExit.mmd "record the merge commit hashes to tasks.json". Mutating.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { recordMergeCommits } from "../shared/recordMergeCommits.ts";
import { getCurrentTaskRun, type TaskCommit } from "../shared/taskRunState.ts";
import { MERGE_COMMITS_ALREADY_RECORDED, MERGE_COMMITS_NOT_RECORDED } from "../../shared/resultCodes.ts";

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

// A resumed run resends the same commits; skip appending when the run's tail already holds them.
function alreadyRecorded(projectRoot: string, taskNumber: number, commits: TaskCommit[]): number {
    if (commits.length === 0) return MERGE_COMMITS_NOT_RECORDED;
    const existing = getCurrentTaskRun(taskNumber, projectRoot)?.commits ?? [];
    if (existing.length < commits.length) return MERGE_COMMITS_NOT_RECORDED;
    return existing.slice(-commits.length).every((commit, i) => commit.hash === commits[i].hash)
        ? MERGE_COMMITS_ALREADY_RECORDED : MERGE_COMMITS_NOT_RECORDED;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as RecordMergeCommitHashesInput;
    if (alreadyRecorded(packet.projectRoot, packet.taskNumber, packet.commits) !== MERGE_COMMITS_ALREADY_RECORDED) {
        recordMergeCommits({
            projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, commits: packet.commits,
        });
    }
    return {
        box: "RECORD_MERGE_COMMIT_HASHES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        worktree: packet.worktree, branch: packet.branch, exitNote: packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
