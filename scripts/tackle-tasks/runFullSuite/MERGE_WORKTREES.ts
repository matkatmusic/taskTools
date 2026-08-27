// MERGE_WORKTREES, from pipeline-runFullSuite.mmd. Mutating: merges worktrees and submodules, no fast-forward.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { mergeTaskWorktree } from "../shared/mergeTaskWorktree.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

function baseBranch(projectRoot: string): string {
    return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
}

// Each landed layer writes its merge ref; publication is read back independently by READ_MERGE_PUBLICATION_STATE, never trusted from this box's return.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as Input & { next?: string };
    const result = mergeTaskWorktree({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        rootSourceBranch: baseBranch(packet.projectRoot),
    });
    return { ...packet, ...result, box: "MERGE_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
