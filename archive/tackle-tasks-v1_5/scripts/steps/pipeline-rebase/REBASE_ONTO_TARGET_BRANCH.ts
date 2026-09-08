// REBASE_ONTO_TARGET_BRANCH, from pipeline-rebase.mmd. Reuses rebaseTaskWorktree (the real, tested git-mutating logic) rather than re-implementing the deepest-first walk here.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { rebaseTaskWorktree } from "../../tackle-tasks/rebaseTaskWorktree.ts";
import type { RebasePacket } from "./packet.ts";

// rebaseTaskWorktree handles lock acquisition and heartbeat refresh itself, so this box skips refreshing a lock it may not hold.
export async function main(input: string): Promise<RebasePacket> {
    const { next: _next, ...packet } = JSON.parse(input) as RebasePacket & { next?: string };

    // ponytail: a layer the merge already landed sits ref-identical to source and rebases as a natural no-op, so landedOccurrenceIds rides through unfiltered rather than being re-derived here.
    const outcome = await rebaseTaskWorktree({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: packet.stepId,
        rootSourceBranch: packet.rootSourceBranch,
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
        finished: false,
        failureReason: outcome.failureReason ?? "",
        exitType: "",
        exitNote: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    main(process.argv[2] ?? "").then((result) => console.log(JSON.stringify(result)));
