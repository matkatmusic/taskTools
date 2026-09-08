// REBASE_ONTO_TARGET_BRANCH, from pipeline-rebase.mmd. Reuses rebaseTaskWorktree, the tested git-mutating logic, rather than re-implementing the deepest-first walk here.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { rebaseTaskWorktree } from "../shared/rebaseTaskWorktree.ts";
import type { RebasePacket } from "./_packet.ts";

const REBASE_STEP_ID = "rebase";

type EntryInput = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    exitType: string;
    exitNote: string;
};

// next is routing metadata from the predecessor; discarded, never carried into this box's own output.
export async function main(input: string): Promise<RebasePacket> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryInput & { next?: string };
    // const rootSourceBranch = execFileSync("git", ["-C", packet.projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    const rootSourceBranch = "staging";

    const outcome = await rebaseTaskWorktree({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: REBASE_STEP_ID,
        rootSourceBranch,
    });
    if (outcome.lock !== "acquired") {
        throw new Error(`REBASE_ONTO_TARGET_BRANCH: source repo lock is not held (${outcome.lock})`);
    }

    return {
        ...packet,
        box: "REBASE_ONTO_TARGET_BRANCH",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        conflicted: outcome.conflicted,
        stoppedOccurrenceId: outcome.stoppedAt?.occurrenceId ?? "",
        stoppedCheckoutPath: outcome.stoppedAt?.checkoutPath ?? "",
        conflictedFilePaths: outcome.conflictedFilePaths,
        failureReason: outcome.failureReason ?? "",
        exitType: "",
        exitNote: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    main(process.argv[2] ?? "").then((result) => console.log(JSON.stringify(result)));
