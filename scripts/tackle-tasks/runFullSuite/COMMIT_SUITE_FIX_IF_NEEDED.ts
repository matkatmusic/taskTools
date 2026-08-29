// COMMIT_SUITE_FIX_IF_NEEDED, from pipeline-runFullSuite.mmd. Mutating: commits dirty layers if any.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { commitTaskWork } from "../shared/commitTaskWork.ts";
import { getAttemptCount } from "../shared/taskRunState.ts";

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

// Narrows down to the core packet, plus the task's own branch, which every later box in this folder carries through.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const attempts = getAttemptCount(packet.taskNumber, "suiteFix", packet.projectRoot);
    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: `fix-suite-${attempts}`,
        rootSourceBranch: baseBranch(packet.projectRoot),
    });
    return {
        box: "COMMIT_SUITE_FIX_IF_NEEDED",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktree,
        branch: packet.branch,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
