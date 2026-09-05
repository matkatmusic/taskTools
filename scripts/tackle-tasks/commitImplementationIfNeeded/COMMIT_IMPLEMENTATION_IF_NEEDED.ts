// COMMIT_IMPLEMENTATION_IF_NEEDED, from pipeline-implement.mmd. Commits the implementer's work, if any.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { commitTaskWork } from "../shared/commitTaskWork.ts";
import type { CommitImplementationIfNeededPacket } from "./_packet.ts";

// The hook merges IMPLEMENT_TASK's input packet with the implementer agent's answer; this is that merge.
type Input = CommitImplementationIfNeededPacket & { message: string; additionalData: Record<string, unknown>; next?: string };

export function main(input: string): Record<string, unknown> {
    const { message: _message, additionalData, next: _next, ...packet } = JSON.parse(input) as Input;
    // Duck-typing retired: FIX_IMPLEMENT_TASK_TESTS's fixSummary answers now route to COMMIT_TEST_FIX_IF_NEEDED instead.
    // if (typeof additionalData.implemented !== "boolean") {
    //     if (typeof additionalData.fixSummary !== "string") {
    //         throw new Error(`COMMIT_IMPLEMENTATION_IF_NEEDED: additionalData holds neither a boolean "implemented" nor a string "fixSummary"`);
    //     }
    // }
    if (typeof additionalData.implemented !== "boolean") {
        throw new Error(`COMMIT_IMPLEMENTATION_IF_NEEDED: additionalData holds no boolean "implemented"`);
    }
    if (!additionalData.implemented) {
        return {
            ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            exitType: "implementation-incomplete", exitNote: String(additionalData.notes ?? ""),
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    // const rootSourceBranch = execFileSync(
    //     "git", ["-C", packet.projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" },
    // ).trim();
    const rootSourceBranch = "staging";
    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: "implement",
        rootSourceBranch,
    });
    return { ...packet, box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "ARE_TASK_TESTS_SKIPPED_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
