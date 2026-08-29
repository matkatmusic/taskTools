// MERGE_SUCCEEDED_EXIT, from pipeline-mergeSucceededExit.mmd. Verifies the merge refs; never trusts the packet's assertion.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { readPublicationState } from "../shared/readPublicationState.ts";
import type { MergeSucceededExitPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as MergeSucceededExitPacket;
    const projectRoot = requireAbsolutePath("projectRoot", packet.projectRoot);
    const worktree = requireAbsolutePath("worktree", packet.worktree);
    const state = readPublicationState({ taskNumber: packet.taskNumber, projectRoot, worktreePath: worktree, rootSourceBranch: "staging" });
    if (state.state !== "ALL LANDED") {
        throw new Error(`MERGE_SUCCEEDED_EXIT: task ${packet.taskNumber} is not ALL LANDED (${state.state}); refusing to archive`);
    }
    return {
        box: "MERGE_SUCCEEDED_EXIT", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, worktree, branch: packet.branch,
        exitNote: "All layers merged successfully.", commits: state.commits,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
