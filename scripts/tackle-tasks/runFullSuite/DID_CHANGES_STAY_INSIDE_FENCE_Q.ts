// DID_CHANGES_STAY_INSIDE_FENCE_Q, from pipeline-runFullSuite.mmd. Re-derives the diff; never trusts a self-report.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { checkTaskFileFence } from "../shared/checkTaskFileFence.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktree: string;
    branch: string;
    output: string;
};

function baseBranch(projectRoot: string): string {
    // return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return "staging";
}

// Narrows down to the core packet: ownedFilePaths/testFilePaths were only needed for the suite-fix loop.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const { inside, violations } = checkTaskFileFence({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        rootSourceBranch: baseBranch(packet.projectRoot),
    });
    const exitNote = `paused, fence-violation: these changed files are outside the task's file fence: ${violations.join(", ")}. nothing merged. worktree preserved. Review those files. Small and part of the task: add them to the task's modifiableFiles or files in tasks.json, then run /tackle-tasks [${packet.taskNumber}] DO_ALL_TESTS_PASS_Q to resume at "do all tests pass?". Large or not part of the task: ask the user what to do.`;
    return {
        box: "DID_CHANGES_STAY_INSIDE_FENCE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktree,
        branch: packet.branch,
        next: inside ? "MERGE_WORKTREES" : "pipeline-failuresExit.mmd::FAILURES_EXIT",
        exitType: inside ? "" : "fence-violation",
        exitNote: inside ? "" : exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
