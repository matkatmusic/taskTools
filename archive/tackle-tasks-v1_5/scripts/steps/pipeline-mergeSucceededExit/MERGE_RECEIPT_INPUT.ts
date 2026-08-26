// MERGE_RECEIPT_INPUT, from pipeline-mergeSucceededExit.mmd. Verifies the merge refs; never trusts the payload's assertion.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";
import { readPublicationState } from "../../tackle-tasks/readPublicationState.ts";

// The real shape EXIT_WORKFLOW_SUCCESS hands on: keep its field names, not the door's old ones.
export type MergeReceiptInputPacket = {
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktreePath: string;
    rootSourceBranch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as MergeReceiptInputPacket;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", packet.worktreePath);
    const state = readPublicationState({ taskNumber: packet.taskNumber, projectRoot, worktreePath });
    if (state.state !== "ALL LANDED") {
        throw new Error(`MERGE_RECEIPT_INPUT: task ${packet.taskNumber} is not ALL LANDED (${state.state}); refusing to archive`);
    }
    return {
        box: "MERGE_RECEIPT_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        worktreePath, rootSourceBranch: packet.rootSourceBranch,
        exitNote: "All layers merged successfully.", commits: state.commits,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
