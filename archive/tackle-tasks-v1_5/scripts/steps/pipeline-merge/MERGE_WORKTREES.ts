// MERGE_WORKTREES, from pipeline-merge.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { mergeTaskWorktree } from "../../tackle-tasks/mergeTaskWorktree.ts";

type Incoming = {
    worktreePath: string;
    rootSourceBranch: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
};

// Try: merge worktrees and submodules, no fast-forward. Each landed layer writes its own merge ref;
// publication is read back independently by READ_MERGE_PUBLICATION_STATE, never trusted from this return.
export function main(input: string): Record<string, unknown> {
    // The incoming packet may carry a decision predecessor's `next`; this box has one successor.
    const { next: _next, ...packet } = JSON.parse(input) as Incoming & { next?: string };
    const result = mergeTaskWorktree({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        rootSourceBranch: packet.rootSourceBranch,
    });
    return { ...packet, ...result, box: "MERGE_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
