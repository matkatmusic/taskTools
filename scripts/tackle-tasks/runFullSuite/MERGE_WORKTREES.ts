// MERGE_WORKTREES, from pipeline-runFullSuite.mmd. Mutating: merges worktrees and submodules, no fast-forward.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { mergeTaskWorktree } from "../shared/mergeTaskWorktree.ts";
import { readPublicationState } from "../shared/readPublicationState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
};

function baseBranch(projectRoot: string): string {
    // return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return "staging";
}

// Each landed layer writes its merge ref; publication is read back independently by READ_MERGE_PUBLICATION_STATE, never trusted from this box's return.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as Input & { next?: string };
    // A resumed run whose merge ref already names the tip must not merge again: the source tip has since moved.
    const publicationState = readPublicationState({
        taskNumber: packet.taskNumber,
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        rootSourceBranch: baseBranch(packet.projectRoot),
    });
    // Deepest-first, matching the order mergeTaskWorktree returns: children before the root.
    const deepestFirstCommits = publicationState.commits
        .slice()
        .sort((a, b) => (a.occurrenceId === "" ? 1 : 0) - (b.occurrenceId === "" ? 1 : 0));
    const result = publicationState.state === "ALL LANDED"
        ? { merged: true, commits: deepestFirstCommits, failureReason: "" }
        : mergeTaskWorktree({
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
