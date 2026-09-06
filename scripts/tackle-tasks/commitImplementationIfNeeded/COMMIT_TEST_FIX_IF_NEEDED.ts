// COMMIT_TEST_FIX_IF_NEEDED, from pipeline-commitImplementationIfNeeded.mmd. Commits FIX_IMPLEMENT_TASK_TESTS's fix, if any.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { commitTaskWork } from "../shared/commitTaskWork.ts";
import { getAttemptCount } from "../shared/taskRunState.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

// The hook merges FIX_IMPLEMENT_TASK_TESTS's input packet with the fixer agent's answer; this is that merge.
type Input = CommitImplementationIfNeededPacket & { message: string; additionalData: Record<string, unknown>; next?: string };

export function main(input: string): Record<string, unknown> {
    const { message: _message, additionalData, next: _next, ...packet } = JSON.parse(input) as Input;
    if (typeof additionalData.fixSummary !== "string") {
        throw new Error(`COMMIT_TEST_FIX_IF_NEEDED: additionalData holds no string "fixSummary"`);
    }
    const rootSourceBranch = "staging";
    const attempts = getAttemptCount(packet.taskNumber, "testFixes", packet.projectRoot);
    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: `fix-test-${attempts}`,
        rootSourceBranch,
    });
    return { ...packet, box: "COMMIT_TEST_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "ARE_TASK_TESTS_SKIPPED_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
